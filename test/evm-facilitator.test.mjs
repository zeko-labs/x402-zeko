import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  SelfHostedEvmFacilitator,
  X402_RESERVE_RELEASE_ESCROW_ABI,
  RelayerSettlementLockError,
  buildBaseMainnetUsdcRail,
  buildBaseMainnetUsdcReserveReleaseFeeRail,
  buildBaseMainnetUsdcReserveReleaseRail,
  buildBaseUsdcExactEip3009Intent,
  buildBaseUsdcReserveReleaseFeeIntent,
  buildBaseUsdcReserveReleaseIntent,
  buildCustomEvmExactEip3009Intent,
  buildCustomEvmExactEip3009Rail,
  buildEthereumMainnetUsdcReserveReleaseRail,
  buildEthereumMainnetUsdcExactEip3009Intent,
  buildEthereumUsdcReserveReleaseIntent,
  buildEthereumMainnetUsdcRail,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSignedEvmAuthorization,
  createHttpRelayerSettlementLock,
  createSelfHostedEvmFacilitatorHttpServer,
  facilitatorVersionInfo
} from "../src/index.js";
import { encodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BUYER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f094538e64d6d95f6d6b6c6d6e6f707172737475";
const RELAYER_PRIVATE_KEY =
  "0x8b3a350cf5c34c9194ca3a9d8b2d8e5d1c4f6b3a2c1d0e9f8a7b6c5d4e3f2a1b";

test("self-hosted facilitator version info exposes the deployed commit sha", () => {
  const previous = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = "abcdef1234567890";

  try {
    const version = facilitatorVersionInfo();
    assert.equal(version.ok, true);
    assert.equal(version.service, "zeko-x402-evm-facilitator");
    assert.equal(version.commitSha, "abcdef1234567890");
    assert.equal(version.source, "env");
  } finally {
    if (previous === undefined) {
      delete process.env.RENDER_GIT_COMMIT;
    } else {
      process.env.RENDER_GIT_COMMIT = previous;
    }
  }
});

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
  const feeAuthorization = input.feeIntent
    ? buildSignedEvmAuthorization(input.feeIntent, {
        signature: await buyer.signTypedData({
          domain: input.feeIntent.typedData.domain,
          types: input.feeIntent.typedData.types,
          primaryType: input.feeIntent.typedData.primaryType,
          message: input.feeIntent.typedData.message
        })
      })
    : undefined;
  const payload = buildPaymentPayload({
    requestId: requirements.requestId,
    paymentId: input.paymentId ?? "pay_self_hosted_demo",
    option,
    payer: buyer.address,
    sessionId: "session_self_hosted",
    turnId: "turn_self_hosted",
    issuedAtIso: "2026-04-24T12:00:00.000Z",
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    authorization,
    ...(feeAuthorization ? { feeAuthorization } : {})
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

test("self-hosted facilitator treats fully settled exact retries as idempotent success", async () => {
  const calls = [];
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const usedNonce = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const mock = {
    publicClient: {
      readContract: async ({ functionName, args }) => {
        calls.push(["readContract", functionName, ...(args ?? [])]);

        if (functionName === "authorizationState") {
          return String(args[1]).toLowerCase() === usedNonce;
        }

        if (functionName === "balanceOf") {
          return 900000n;
        }

        throw new Error(`Unexpected readContract function: ${functionName}`);
      }
    },
    walletClient: {
      writeContract: async () => {
        throw new Error("fully settled retry should not broadcast");
      }
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: rail.amount,
    nonce: usedNonce
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
  assert.equal(verification.settlementState, "already_settled");
  assert.equal(verification.duplicate, true);
  assert.equal(settlement.success, true);
  assert.equal(settlement.duplicate, true);
  assert.equal(settlement.settlementState, "already_settled");
  assert.equal(calls.some((entry) => entry[0] === "writeContract"), false);
});

test("self-hosted facilitator rejects reverted settlement receipts", async () => {
  const mock = createMockClients();
  mock.publicClient = {
    ...mock.publicClient,
    waitForTransactionReceipt: async ({ hash }) => {
      mock.calls.push(["waitForTransactionReceipt", hash]);
      return {
        status: "reverted",
        blockHash: "0xblockhashdemo",
        blockNumber: 123n
      };
    }
  };
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

  const settlement = await facilitator.settle({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(settlement.success, false);
  assert.equal(settlement.errorCode, "settlement_failed");
  assert.equal(settlement.errorReason, "Settlement transaction reverted.");
});

test("self-hosted facilitator enforces and settles exact Base protocol-fee split", async () => {
  const mock = createMockClients();
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000face",
    feeBps: 100,
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: "0.495",
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  const feeIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: "0x000000000000000000000000000000000000face",
    amount: "0.005",
    nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent, feeIntent });
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

  const transferCalls = mock.calls.filter(
    (entry) => entry[0] === "writeContract" && entry[1] === "transferWithAuthorization"
  );

  assert.equal(verification.isValid, true);
  assert.equal(verification.feeSplit.protocolFeeAmount, "5000");
  assert.equal(settlement.success, true);
  assert.equal(settlement.feeSplit.sellerAmount, "495000");
  assert.equal(settlement.feeSplit.protocolFeeAmount, "5000");
  assert.equal(transferCalls.length, 2);
  assert.equal(transferCalls[0][3], "0x000000000000000000000000000000000000face");
  assert.equal(transferCalls[0][4], "5000");
  assert.equal(transferCalls[1][3], "0x000000000000000000000000000000000000bEEF");
  assert.equal(transferCalls[1][4], "495000");
});

test("self-hosted facilitator allocates pending relayer nonces across fee-split settlement legs", async () => {
  const calls = [];
  const mock = createMockClients();
  mock.publicClient = {
    ...mock.publicClient,
    getTransactionCount: async ({ address, blockTag }) => {
      calls.push(["getTransactionCount", address, blockTag]);
      return 17;
    }
  };
  mock.walletClient = {
    writeContract: async ({ functionName, nonce }) => {
      calls.push(["writeContract", functionName, nonce]);
      return nonce === 17 ? "0xfeetxhash" : "0xsellertxhash";
    }
  };
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000face",
    feeBps: 100,
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: "0.495",
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  const feeIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: "0x000000000000000000000000000000000000face",
    amount: "0.005",
    nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent, feeIntent });
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
  const writeCalls = calls.filter((entry) => entry[0] === "writeContract");

  assert.equal(settlement.success, true);
  assert.deepEqual(
    calls.filter((entry) => entry[0] === "getTransactionCount").map((entry) => entry[2]),
    ["pending"]
  );
  assert.deepEqual(writeCalls.map((entry) => entry[2]), [17, 18]);
});

test("self-hosted facilitator serializes concurrent settlements for one relayer", async () => {
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const mock = createMockClients();
  mock.walletClient = {
    writeContract: async () => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeWrites -= 1;
      return "0xtxhashdemo";
    }
  };
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const firstIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: rail.amount,
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  const secondIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: rail.amount,
    nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  const first = await buildSignedPayment({
    rail,
    intent: firstIntent,
    paymentId: "pay_self_hosted_concurrent_one"
  });
  const second = await buildSignedPayment({
    rail,
    intent: secondIntent,
    paymentId: "pay_self_hosted_concurrent_two"
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

  const [firstSettlement, secondSettlement] = await Promise.all([
    facilitator.settle({
      paymentPayload: first.payload,
      paymentRequirements: first.requirements
    }),
    facilitator.settle({
      paymentPayload: second.payload,
      paymentRequirements: second.requirements
    })
  ]);

  assert.equal(firstSettlement.success, true);
  assert.equal(secondSettlement.success, true);
  assert.equal(maxActiveWrites, 1);
});

test("self-hosted facilitator can wrap settlement with an external relayer lock", async () => {
  const events = [];
  const mock = createMockClients();
  mock.walletClient = {
    writeContract: async () => {
      events.push("write");
      return "0xtxhashdemo";
    }
  };
  const relayerAddress = privateKeyToAccount(RELAYER_PRIVATE_KEY).address;
  const relayerSettlementLock = {
    info: { type: "test-lock" },
    acquire: async (key, context) => {
      events.push("acquire");
      assert.equal(key, `eip155:8453:${relayerAddress.toLowerCase()}`);
      assert.equal(context.networkId, "eip155:8453");
      assert.equal(context.relayer, relayerAddress);
      return async () => {
        events.push("release");
      };
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_external_lock"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    relayerSettlementLock,
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
  const supported = await facilitator.supported();

  assert.equal(settlement.success, true);
  assert.deepEqual(events, ["acquire", "write", "release"]);
  assert.equal(supported.networks[0].relayerSettlementCoordination.type, "test-lock");
});

test("self-hosted facilitator renews HTTP relayer locks during long settlements", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const body = JSON.parse(options.body ?? "{}");
    calls.push({
      path: parsedUrl.pathname,
      authorization: options.headers?.authorization,
      body
    });

    if (parsedUrl.pathname.endsWith("/acquire")) {
      return new Response(JSON.stringify({ acquired: true, lockId: "lock_http_demo" }), { status: 200 });
    }

    if (parsedUrl.pathname.endsWith("/renew")) {
      return new Response(JSON.stringify({ renewed: true, lockId: "lock_http_demo" }), { status: 200 });
    }

    if (parsedUrl.pathname.endsWith("/release")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };

  try {
    const mock = createMockClients();
    mock.walletClient = {
      writeContract: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "0xtxhashdemo";
      }
    };
    const relayerSettlementLock = createHttpRelayerSettlementLock({
      url: "https://lock.example/x402-relayer-lock",
      bearerToken: "secret_lock_token",
      ttlMs: 60,
      renewIntervalMs: 5,
      requestTimeoutMs: 1000
    });
    const rail = buildBaseMainnetUsdcRail({
      payTo: "0x000000000000000000000000000000000000bEEF",
      amount: "0.50"
    });
    const intent = buildBaseUsdcExactEip3009Intent({
      from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
      to: rail.payTo,
      amount: rail.amount
    });
    const { requirements, payload } = await buildSignedPayment({
      rail,
      intent,
      paymentId: "pay_self_hosted_http_lock_renewal"
    });
    const facilitator = new SelfHostedEvmFacilitator({
      relayerSettlementLock,
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
    const paths = calls.map((entry) => entry.path);
    const renewCalls = calls.filter((entry) => entry.path.endsWith("/renew"));

    assert.equal(settlement.success, true);
    assert.ok(paths.includes("/x402-relayer-lock/acquire"));
    assert.ok(paths.includes("/x402-relayer-lock/release"));
    assert.ok(renewCalls.length >= 1);
    assert.ok(calls.every((entry) => entry.authorization === "Bearer secret_lock_token"));
    assert.ok(renewCalls.every((entry) => entry.body.ttlMs === 60));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("self-hosted facilitator marks external relayer lock failures as recoverable", async () => {
  const mock = createMockClients();
  mock.walletClient = {
    writeContract: async () => {
      throw new Error("writeContract should not be called when the relayer lock is unavailable");
    }
  };
  const relayerSettlementLock = {
    info: { type: "test-lock" },
    acquire: async () => {
      throw new RelayerSettlementLockError("relayer lock busy", { retryAfterMs: 333 });
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_external_lock_busy"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    relayerSettlementLock,
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
  assert.equal(settlement.errorCode, "relayer_lock_unavailable");
  assert.equal(settlement.settlementState, "settlement_pending");
  assert.equal(settlement.recoverable, true);
  assert.equal(settlement.retryAfterMs, 333);
  assert.match(settlement.errorReason, /relayer lock busy/);
});

test("self-hosted facilitator marks relayer nonce conflicts as recoverable", async () => {
  const mock = createMockClients();
  mock.walletClient = {
    writeContract: async () => {
      throw new Error("replacement transaction underpriced");
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_nonce_conflict"
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
  assert.equal(settlement.errorCode, "relayer_nonce_conflict");
  assert.equal(settlement.settlementState, "settlement_pending");
  assert.equal(settlement.recoverable, true);
  assert.equal(settlement.retryAfterMs, 2500);
  assert.match(settlement.errorReason, /replacement transaction underpriced/);
});

test("self-hosted facilitator resumes partially settled exact fee-split payloads", async () => {
  const calls = [];
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const sellerNonce = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const feeNonce = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const usedNonces = new Set([feeNonce.toLowerCase()]);
  const mock = {
    publicClient: {
      readContract: async ({ functionName, args }) => {
        calls.push(["readContract", functionName, ...(args ?? [])]);

        if (functionName === "authorizationState") {
          return usedNonces.has(String(args[1]).toLowerCase());
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
        calls.push(["writeContract", functionName, args[0], args[1], args[2].toString(), args[5]]);
        usedNonces.add(String(args[5]).toLowerCase());
        return "0xsellertxhash";
      }
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000face",
    feeBps: 100,
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: "0.495",
    nonce: sellerNonce
  });
  const feeIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: "0x000000000000000000000000000000000000face",
    amount: "0.005",
    nonce: feeNonce
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent, feeIntent });
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
  const transferCalls = calls.filter(
    (entry) => entry[0] === "writeContract" && entry[1] === "transferWithAuthorization"
  );

  assert.equal(verification.isValid, true);
  assert.equal(verification.settlementState, "partial_settlement");
  assert.equal(verification.recoverable, true);
  assert.equal(verification.nextSettlementAction, "resume_seller");
  assert.equal(settlement.success, true);
  assert.equal(settlement.resumed, true);
  assert.equal(settlement.transactionHash, "0xsellertxhash");
  assert.equal(transferCalls.length, 1);
  assert.equal(transferCalls[0][3], "0x000000000000000000000000000000000000bEEF");
  assert.equal(transferCalls[0][5], sellerNonce);
});

test("self-hosted facilitator verify marks seller-settled fee-split payloads as recoverable", async () => {
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const sellerNonce = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const feeNonce = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const usedNonces = new Set([sellerNonce.toLowerCase()]);
  const mock = {
    publicClient: {
      readContract: async ({ functionName, args }) => {
        if (functionName === "authorizationState") {
          return usedNonces.has(String(args[1]).toLowerCase());
        }

        if (functionName === "balanceOf") {
          return 900000n;
        }

        throw new Error(`Unexpected readContract function: ${functionName}`);
      }
    },
    walletClient: {
      writeContract: async () => {
        throw new Error("verify should not broadcast");
      }
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000face",
    feeBps: 100,
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: "0.495",
    nonce: sellerNonce
  });
  const feeIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: "0x000000000000000000000000000000000000face",
    amount: "0.005",
    nonce: feeNonce
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent, feeIntent });
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

  assert.equal(verification.isValid, true);
  assert.equal(verification.settlementState, "partial_settlement");
  assert.equal(verification.recoverable, true);
  assert.equal(verification.nextSettlementAction, "resume_protocol_fee");
  assert.equal(verification.authorizationUsed, true);
  assert.equal(verification.feeAuthorizationUsed, false);
});

test("self-hosted facilitator treats fully settled exact fee-split retries as idempotent success", async () => {
  const calls = [];
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const sellerNonce = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const feeNonce = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const usedNonces = new Set([sellerNonce.toLowerCase(), feeNonce.toLowerCase()]);
  const mock = {
    publicClient: {
      readContract: async ({ functionName, args }) => {
        calls.push(["readContract", functionName, ...(args ?? [])]);

        if (functionName === "authorizationState") {
          return usedNonces.has(String(args[1]).toLowerCase());
        }

        if (functionName === "balanceOf") {
          return 900000n;
        }

        throw new Error(`Unexpected readContract function: ${functionName}`);
      }
    },
    walletClient: {
      writeContract: async () => {
        throw new Error("fully settled retry should not broadcast");
      }
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000face",
    feeBps: 100,
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: rail.payTo,
    amount: "0.495",
    nonce: sellerNonce
  });
  const feeIntent = buildBaseUsdcExactEip3009Intent({
    from: buyerAddress,
    to: "0x000000000000000000000000000000000000face",
    amount: "0.005",
    nonce: feeNonce
  });
  const { requirements, payload } = await buildSignedPayment({ rail, intent, feeIntent });
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
  assert.equal(verification.settlementState, "already_settled");
  assert.equal(verification.duplicate, true);
  assert.equal(settlement.success, true);
  assert.equal(settlement.duplicate, true);
  assert.equal(settlement.settlementState, "already_settled");
  assert.equal(calls.some((entry) => entry[0] === "writeContract"), false);
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

test("self-hosted facilitator supports custom CAIP-2 EVM exact EIP-3009 rails", async () => {
  const mock = createMockClients();
  const target = {
    networkId: "eip155:4217",
    chainName: "Tempo",
    tokenAddress: "0x20c000000000000000000000b9537d11c60e8b50",
    assetSymbol: "USDC.e",
    decimals: 6,
    eip712Name: "Bridged USDC (Stargate)"
  };
  const rail = buildCustomEvmExactEip3009Rail({
    ...target,
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.25"
  });
  const intent = buildCustomEvmExactEip3009Intent({
    ...target,
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_custom_evm"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:4217",
        rpcUrl: "https://tempo.example",
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
  assert.equal(verification.network, "eip155:4217");
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

test("self-hosted facilitator does not treat used reserve-release authorizations as settled without reservation proof", async () => {
  const buyerAddress = privateKeyToAccount(BUYER_PRIVATE_KEY).address;
  const nonce = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const calls = [];
  const mock = {
    publicClient: {
      readContract: async ({ functionName, args }) => {
        calls.push(["readContract", functionName, ...(args ?? [])]);

        if (functionName === "authorizationState") {
          return String(args[1]).toLowerCase() === nonce.toLowerCase();
        }

        if (functionName === "balanceOf") {
          return 900000n;
        }

        throw new Error(`Unexpected readContract function: ${functionName}`);
      }
    },
    walletClient: {
      writeContract: async ({ functionName }) => {
        calls.push(["writeContract", functionName]);
        throw new Error("EIP-3009 authorization nonce was already used.");
      }
    }
  };
  const rail = buildBaseMainnetUsdcReserveReleaseRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999"
  });
  const intent = buildBaseUsdcReserveReleaseIntent({
    from: buyerAddress,
    payTo: rail.payTo,
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_self_hosted_reserve_used_nonce",
    paymentId: "pay_self_hosted_reserve_used_nonce",
    amount: rail.amount,
    nonce,
    resultDigest: "proof_result_digest_used_nonce"
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_reserve_used_nonce"
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
  assert.equal(settlement.errorCode, "authorization_used");
  assert.equal(settlement.duplicate, undefined);
  assert.notEqual(settlement.settlementState, "already_settled");
  assert.equal(settlement.verification.authorizationUsed, true);
  assert.equal(
    calls.some((entry) => entry[0] === "writeContract" && entry[1] === "reserveExactWithAuthorization"),
    true
  );
});

test("self-hosted facilitator can reserve Ethereum USDC into a reserve-release escrow contract", async () => {
  const mock = createMockClients();
  const rail = buildEthereumMainnetUsdcReserveReleaseRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.75",
    escrowContract: "0x8888888888888888888888888888888888888888"
  });
  const intent = buildEthereumUsdcReserveReleaseIntent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    payTo: rail.payTo,
    escrowContract: "0x8888888888888888888888888888888888888888",
    requestId: "req_self_hosted_eth_reserve",
    paymentId: "pay_self_hosted_eth_reserve",
    amount: rail.amount,
    resultDigest: "proof_result_digest_eth"
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_eth_reserve"
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

  const settlement = await facilitator.settle({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(settlement.success, true);
  assert.equal(settlement.settlementModel, "x402-ethereum-mainnet-usdc-reserve-release-v2");
  assert.equal(
    mock.calls.some((entry) => entry[0] === "writeContract" && entry[1] === "reserveExactWithAuthorization"),
    true
  );
});

test("self-hosted facilitator rejects tampered hosted fee split settlement terms", async () => {
  const mock = createMockClients();
  const rail = buildBaseMainnetUsdcReserveReleaseFeeRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
    feeBps: 100,
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999"
  });
  const intent = buildBaseUsdcReserveReleaseFeeIntent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    payTo: rail.payTo,
    protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
    feeBps: 100,
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_self_hosted_fee_tamper",
    paymentId: "pay_self_hosted_fee_tamper",
    amount: rail.amount,
    resultDigest: "proof_result_digest_fee_tamper"
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_fee_tamper"
  });

  payload.authorization.settlement.feeBps = 0;
  payload.authorization.settlement.protocolFeeAmount = "0";
  payload.authorization.settlement.sellerAmount = "500000";
  payload.authorization.settlement.protocolFeePayTo = "0x000000000000000000000000000000000000dEaD";

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

  await assert.rejects(
    () =>
      facilitator.settle({
        paymentPayload: payload,
        paymentRequirements: requirements
      }),
    /must match the advertised reserve-release fee split/
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

test("self-hosted facilitator retries transient read-side RPC failures", async () => {
  let balanceReads = 0;
  const mock = createMockClients();
  const publicClient = {
    ...mock.publicClient,
    readContract: async ({ functionName }) => {
      if (functionName === "authorizationState") {
        return false;
      }

      if (functionName === "balanceOf") {
        balanceReads += 1;
        if (balanceReads === 1) {
          throw new Error("over rate limit");
        }
        return 900000n;
      }

      throw new Error(`Unexpected readContract function: ${functionName}`);
    }
  };
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: privateKeyToAccount(BUYER_PRIVATE_KEY).address,
    to: rail.payTo,
    amount: rail.amount
  });
  const { requirements, payload } = await buildSignedPayment({
    rail,
    intent,
    paymentId: "pay_self_hosted_retry"
  });
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base.example",
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient,
        walletClient: mock.walletClient,
        rpcRetryCount: 1,
        rpcRetryDelayMs: 1
      }
    ]
  });

  const verification = await facilitator.verify({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(verification.isValid, true);
  assert.equal(balanceReads, 2);
});

test("self-hosted facilitator reports configured RPC failover URLs without exposing API keys", async () => {
  const mock = createMockClients();
  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:8453",
        rpcUrl: "https://base-mainnet.g.alchemy.com/v2/privateApiKey123456789",
        rpcUrls: [
          "https://base-mainnet.g.alchemy.com/v2/privateApiKey123456789",
          "https://mainnet.base.org"
        ],
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        publicClient: mock.publicClient,
        walletClient: mock.walletClient
      }
    ]
  });

  const supported = await facilitator.supported();
  assert.equal(supported.ok, true);
  assert.deepEqual(supported.networks[0].rpcUrls, [
    "https://base-mainnet.g.alchemy.com/v2/redacted",
    "https://mainnet.base.org/"
  ]);
  assert.equal(supported.networks[0].rpcUrl, "https://base-mainnet.g.alchemy.com/v2/redacted");
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
    const docs = await fetch(`${baseUrl}/docs`).then((response) => response.json());
    const openapi = await fetch(`${baseUrl}/openapi.json`).then((response) => response.json());
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
    const invalidVerification = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: requirements, paymentRequirements: requirements })
    });
    const invalidVerificationBody = await invalidVerification.json();

    assert.equal(supported.ok, true);
    assert.equal(supported.networks[0].networkId, "eip155:8453");
    assert.equal(docs.service, "zeko-x402-evm-facilitator");
    assert.equal(openapi.openapi, "3.1.0");
    assert.equal(verification.isValid, true);
    assert.equal(settlement.success, true);
    assert.equal(invalidVerification.status, 400);
    assert.equal(invalidVerificationBody.errorCode, "invalid_request");
    assert.match(invalidVerificationBody.error, /paymentPayload\.accepted\.asset|networkId|settlementRail/);
  } finally {
    server.close();
  }
});
