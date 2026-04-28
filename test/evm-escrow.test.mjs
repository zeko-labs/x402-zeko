import assert from "node:assert/strict";
import test from "node:test";

import {
  X402_EVM_USDC_RESERVE_RELEASE_KIND,
  X402_PAUSER_ROLE,
  X402_RELEASER_ROLE,
  inspectReserveReleaseEscrow
} from "../src/index.js";

const ESCROW_ADDRESS = "0x1111111111111111111111111111111111111111";
const TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";
const RELEASER_ADDRESS = "0x3333333333333333333333333333333333333333";
const PAUSER_ADDRESS = "0x4444444444444444444444444444444444444444";

test("escrow inspection reports a healthy reserve-release contract", async () => {
  const calls = [];
  const publicClient = {
    async getCode({ address }) {
      calls.push(["getCode", address]);
      return "0x6001600055";
    },
    async readContract({ functionName, args }) {
      calls.push(["readContract", functionName, args ?? []]);

      if (functionName === "usdc") {
        return TOKEN_ADDRESS;
      }

      if (functionName === "hasRole") {
        if (args[0] === X402_RELEASER_ROLE && args[1] === RELEASER_ADDRESS) {
          return true;
        }

        if (args[0] === X402_PAUSER_ROLE && args[1] === PAUSER_ADDRESS) {
          return true;
        }
      }

      throw new Error(`Unexpected readContract call: ${functionName}`);
    }
  };

  const inspection = await inspectReserveReleaseEscrow({
    publicClient,
    escrowAddress: ESCROW_ADDRESS,
    expectedTokenAddress: TOKEN_ADDRESS,
    releaserAddress: RELEASER_ADDRESS,
    pauserAddress: PAUSER_ADDRESS
  });

  assert.equal(inspection.ok, true);
  assert.equal(inspection.contractKind, X402_EVM_USDC_RESERVE_RELEASE_KIND);
  assert.equal(inspection.tokenAddress, TOKEN_ADDRESS);
  assert.equal(inspection.matchesExpectedToken, true);
  assert.equal(inspection.releaserAuthorized, true);
  assert.equal(inspection.pauserAuthorized, true);
  assert.deepEqual(inspection.inspectionErrors, []);
  assert.equal(calls[0][0], "getCode");
});

test("escrow inspection reports when no contract code exists", async () => {
  const publicClient = {
    async getCode() {
      return "0x";
    },
    async readContract() {
      throw new Error("readContract should not be called when code is missing");
    }
  };

  const inspection = await inspectReserveReleaseEscrow({
    publicClient,
    escrowAddress: ESCROW_ADDRESS
  });

  assert.equal(inspection.ok, false);
  assert.equal(inspection.codePresent, false);
  assert.match(inspection.inspectionErrors[0], /No contract code found/i);
});

test("escrow inspection reports token and role mismatches", async () => {
  const publicClient = {
    async getCode() {
      return "0x6001600055";
    },
    async readContract({ functionName }) {
      if (functionName === "usdc") {
        return "0x5555555555555555555555555555555555555555";
      }

      if (functionName === "hasRole") {
        return false;
      }

      throw new Error(`Unexpected readContract call: ${functionName}`);
    }
  };

  const inspection = await inspectReserveReleaseEscrow({
    publicClient,
    escrowAddress: ESCROW_ADDRESS,
    expectedTokenAddress: TOKEN_ADDRESS,
    releaserAddress: RELEASER_ADDRESS,
    pauserAddress: PAUSER_ADDRESS
  });

  assert.equal(inspection.ok, false);
  assert.equal(inspection.matchesExpectedToken, false);
  assert.equal(inspection.releaserAuthorized, false);
  assert.equal(inspection.pauserAuthorized, false);
  assert.equal(inspection.inspectionErrors.length, 3);
});

test("escrow inspection rejects invalid addresses up front", async () => {
  const publicClient = {
    async getCode() {
      return "0x";
    },
    async readContract() {
      return null;
    }
  };

  await assert.rejects(
    () =>
      inspectReserveReleaseEscrow({
        publicClient,
        escrowAddress: "not-an-address"
      }),
    /escrowAddress must be a valid EVM address/i
  );
});
