import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  SelfHostedEvmFacilitator,
  X402_RESERVE_RELEASE_ESCROW_ABI,
  buildBaseMainnetUsdcRail,
  buildBaseMainnetUsdcReserveReleaseRail,
  buildBaseUsdcExactEip3009Intent,
  buildBaseUsdcReserveReleaseIntent,
  buildEthereumMainnetUsdcExactEip3009Intent,
  buildEthereumMainnetUsdcRail,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSignedEvmAuthorization,
  createSelfHostedEvmFacilitatorHttpServer
} from "../src/index.js";
import { encodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BUYER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f094538e64d6d95f6d6b6c6d6e6f707172737475";
const RELAYER_PRIVATE_KEY =
  "0x8b3a350cf5c34c9194ca3a9d8b2d8e5d1c4f6b3a2c1d0e9f8a7b6c5d4e3f2a1b";

function sampleContext(rail) {
  return {
    serviceId: "zeko-x402-self-hosted-evm",
    baseUrl: "https://service.example",
    proofBundleUrl: "https://service.example/proof-bundle",
    verifyUrl: "https://service.example/verify",
    sessionId: "session_self_hosted",
    turnId: "turn_self_hosted",
    rails: [rail]
  };
}

async function buildSignedPayment(input) {
  const buyer = privateKeyToAccount(BUYER_PRIVATE_KEY);
  const requirements = buildPaymentRequired(sampleContext(input.rail));
  const option = requirements.accepts[0];
  const signature = await buyer.signTypedData({
    domain: input.intent.typedData.domain,
    types: input.intent.typedData.types,
    primaryType: input.intent.typedData.primaryType,
    message: input.intent.typedData.message
  });
  const authorization = buildSignedEvmAuthorization(input.intent, { signature });
  const payload = buildPaymentPayload({
    requestId: requirements.requestId,
    paymentId: input.paymentId ?? "pay_self_hosted_demo",
    option,
    payer: buyer.address,
    sessionId: "session_self_hosted",
    turnId: "turn_self_hosted",
    issuedAtIso: "2026-04-24T12:00:00.000Z",
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    authorization
  });

  return {
    buyer,
    requirements,
    option,
    payload
  };
}

function createMockClients() {
  const calls = [];

  return {
    calls,
    publicClient: {
      readContract: async ({ functionName }) => {
        calls.push(["readContract", functionName]);

        if (functionName === "authorizationState") {
          return false;
        }

        if (functionName === "balanceOf") {
          return 900000n;
        }

        throw new Error(`Unexpected readContract function: ${functionName}`);
      },
      waitForTransactionReceipt: async ({ hash }) => {
        calls.push(["waitForTransactionReceipt", hash]);
        return {
          status: "success",
          blockHash: "0xblockhashdemo",
          blockNumber: 123n
        };
      }
    },
    walletClient: {
      writeContract: async ({ functionName, args }) => {
        calls.push(["writeContract", functionName, args[0], args[1], args[2].toString()]);
        return "0xtxhashdemo";
      }
    }
  };
}

test("self-hosted facilitator verifies and settles Base x402 payments", async () => {
  const mock = createMockClients();
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent });
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base.example",
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  const verification = await facilitator.verify({
    paymentPayload: payload,
    paymentRequirements: requirements
  });
  const settlement = await facilitator.settle({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(verification.isValid, true);
  assert.equal(verification.network, "eip155:8453");
  assert.equal(settlement.success, true);
  assert.equal(settlement.transactionHash, "0xtxhashdemo");
  assert.equal(mock.calls.some((entry) => entry[0] === "writeContract"), true);
});

test("self-hosted facilitator supports Ethereum mainnet with the same EIP-3009 flow", async () => {
  const mock = createMockClients();
  const rail = buildEthereumMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.75",
    facilitatorUrl: "http://127.0.0.1:7422"
  });
  const intent = buildEthereumMainnetUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_eth"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:1",
        rpcUrl: "https://ethereum.example",
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  const verification = await facilitator.verify({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(verification.isValid, true);
  assert.equal(verification.network, "eip155:1");
});

test("self-hosted facilitator can reserve Base USDC into a reserve-release escrow contract", async () => {
  const mock = createMockClients();
  const rail = buildBaseMainnetUsdcReserveReleaseRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999"
  });
  const intent = buildBaseUsdcReserveReleaseIntent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    payTo: rail.payTo,
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_self_hosted_reserve",
    paymentId: "pay_self_hosted_reserve",
    amount: rail.amount,
    resultDigest: "proof_result_digest_demo"
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_reserve"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base.example",
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  const settlement = await facilitator.settle({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(settlement.success, true);
  assert.equal(settlement.settlementModel, "x402-base-usdc-reserve-release-v2");
  assert.equal(
    mock.calls.some((entry) => entry[0] === "writeContract" && entry[1] === "reserveExactWithAuthorization"),
    true
  );
});

test("self-hosted facilitator surfaces decoded escrow custom errors on settlement failure", async () => {
  const mock = createMockClients();
  mock.walletClient.writeContract = async () => {
    const revertData = encodeErrorResult({
      abi: X402_RESERVE_RELEASE_ESCROW_ABI,
      errorName: "ReservationExpired",
      args: ["0x" + "11".repeat(32), 1234567890n]
    });
    const error = new Error("execution reverted");
    error.data = revertData;
    throw error;
  };

  const rail = buildBaseMainnetUsdcReserveReleaseRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999"
  });
  const intent = buildBaseUsdcReserveReleaseIntent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    payTo: rail.payTo,
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_self_hosted_expired",
    paymentId: "pay_self_hosted_expired",
    amount: rail.amount,
    resultDigest: "proof_result_digest_expired"
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_expired"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base.example",
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  const settlement = await facilitator.settle({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(settlement.success, false);
  assert.equal(settlement.errorCode, "contract_revert");
  assert.equal(settlement.errorName, "ReservationExpired");
  assert.deepEqual(settlement.errorArgs, ["0x" + "11".repeat(32), "1234567890"]);
  assert.match(settlement.errorReason, /ReservationExpired/);
});

test("self-hosted facilitator reports configured RPC failover URLs", async () => {
  const mock = createMockClients();
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base-primary.example",
        rpcUrls: ["https://base-primary.example", "https://base-secondary.example"],
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  const supported = await facilitator.supported();
  assert.equal(supported.ok, true);
  assert.deepEqual(supported.networks[0].rpcUrls, [
    "https://base-primary.example",
    "https://base-secondary.example"
  ]);
  assert.equal(supported.networks[0].rpcUrl, "https://base-primary.example");
});

test("self-hosted facilitator HTTP server exposes supported, verify, and settle routes", async (t) => {
  const mock = createMockClients();
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent });
  const server = createSelfHostedEvmFacilitatorHttpServer({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base.example",
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Sandbox does not permit binding a local HTTP port.");
      return;
    }

    throw error;
  }

  try {
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener.");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const supported = await fetch(`${baseUrl}/supported`).then((response) => response.json());
    const verification = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements: requirements
      })
    }).then((response) => response.json());
    const settlement = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements: requirements
      })
    }).then((response) => response.json());

    assert.equal(supported.ok, true);
    assert.equal(supported.networks[0].networkId, "eip155:8453");
    assert.equal(verification.isValid, true);
    assert.equal(settlement.success, true);
  } finally {
    server.close();
  }
});
