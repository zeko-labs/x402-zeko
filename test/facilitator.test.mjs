import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFileBackedSettlementWitnessProvider,
  createHttpSettlementWitnessProvider,
  createSettlementWitnessHttpServer,
  HTTPFacilitatorClient,
  InMemorySettlementLedger,
  X402_SETTLEMENT_METHOD,
  assertPaymentPayload,
  buildAuthorizationDigest,
  buildCircleGatewayBaseUsdcRail,
  buildBaseMainnetUsdcRail,
  buildBaseUsdcCircleGatewayIntent,
  buildBaseUsdcExactEip3009Intent,
  buildCatalog,
  buildPaymentContextDigest,
  buildPaymentRequired,
  buildSignedEvmAuthorization,
  buildSignedPaymentPayload,
  buildSignedZekoNativePaymentAuthorization,
  buildSignedZekoZkappAuthorization,
  buildSettlementResponse,
  buildZekoExactSettlementIntent,
  buildZekoNativeTransferFallbackIntent,
  buildZekoSettlementContractRail,
  decodeBase64Json,
  deserializeMerkleMapWitness,
  encodeBase64Json,
  prepareSignedZekoSettlementAuthorization,
  persistSettlementWitnessUpdate,
  readSettlementStore,
  serializeMerkleMapWitness,
  submitZekoAuthorization,
  verifyPayment
} from "../src/index.js";

function sampleContext() {
  return {
    serviceId: "zeko-proof-service",
    serviceNetworkId: "zeko:testnet",
    baseUrl: "https://payments.example",
    proofBundleUrl: "https://payments.example/api/proof",
    verifyUrl: "https://payments.example/api/proof/verify",
    sessionId: "session_demo",
    turnId: "turn_001",
    rails: [
      buildZekoSettlementContractRail({
        contractAddress: "B62qcontract11111111111111111111111111111111111111111111111111111",
        beneficiaryAddress: "B62qbeneficiary1111111111111111111111111111111111111111111111111",
        amount: "0.015",
        bundleDigestSha256: "proof_bundle_digest_demo",
        programmablePrivacy: {
          selectedLocation: "server",
          options: [{ location: "server", label: "Server prover", available: true }]
        },
        kernelPath: ["EscrowKernel.reserveBudget", "EscrowKernel.settleTurn"]
      }),
      buildBaseMainnetUsdcRail({
        amount: "0.50",
        payTo: "0x1111111111111111111111111111111111111111"
      })
    ]
  };
}

test("builds multi-rail Zeko and EVM payment options for one resource", () => {
  const context = sampleContext();
  const catalog = buildCatalog(context);
  const required = buildPaymentRequired(context);
  const zekoOption = required.accepts.find((option) => option.settlementRail === "zeko");
  const evmOption = required.accepts.find((option) => option.settlementRail === "evm");

  assert.equal(catalog.protocol, "x402");
  assert.equal(catalog.facilitator.mode, "multi-rail");
  assert.equal(catalog.routes[0].accepts.length, 2);
  assert.equal(catalog.routes[0].accepts[0].scheme, "exact");
  assert.equal(zekoOption.network, "zeko:testnet");
  assert.equal(zekoOption.asset.symbol, "tMINA");
  assert.equal(zekoOption.payTo, "B62qcontract11111111111111111111111111111111111111111111111111111");
  assert.equal(zekoOption.extensions.zeko.primitive, "zeko-exact-settlement-zkapp-v1");
  assert.equal(evmOption.network, "eip155:8453");
  assert.equal(evmOption.asset.symbol, "USDC");
});

test("verifies and settles either Zeko-native or EVM payments", () => {
  const context = sampleContext();
  const required = buildPaymentRequired(context);
  const zekoOption = required.accepts.find((option) => option.settlementRail === "zeko");
  const evmOption = required.accepts.find((option) => option.settlementRail === "evm");

  const zekoLedger = new InMemorySettlementLedger({
    budgetAsset: zekoOption.asset,
    sponsoredBudget: "0.500"
  });
  const evmLedger = new InMemorySettlementLedger({
    budgetAsset: evmOption.asset,
    sponsoredBudget: "1.00"
  });

  const zekoPayloadWithoutDigest = {
    protocol: "x402",
    version: "2",
    requestId: required.requestId,
    paymentId: "pay_demo_zeko_001",
    scheme: "exact",
    settlementRail: "zeko",
    networkId: zekoOption.network,
    asset: zekoOption.asset,
    amount: zekoOption.amount,
    payer: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    payTo: zekoOption.payTo,
    sessionId: context.sessionId,
    turnId: context.turnId,
    issuedAtIso: "2026-04-23T12:00:00.000Z",
    expiresAtIso: "2099-01-01T00:00:00.000Z"
  };
  const zekoPayload = assertPaymentPayload({
    ...zekoPayloadWithoutDigest,
    authorizationDigest: buildAuthorizationDigest(zekoPayloadWithoutDigest)
  });
  const zekoVerification = verifyPayment({
    requirements: required,
    payload: zekoPayload,
    duplicate: false,
    now: Date.parse("2026-04-23T12:30:00.000Z")
  });
  assert.equal(zekoVerification.ok, true);
  assert.equal(zekoVerification.settlementRail, "zeko");

  const zekoSettlement = zekoLedger.settle({
    paymentId: zekoPayload.paymentId,
    requestId: zekoPayload.requestId,
    settlementRail: zekoPayload.settlementRail,
    amount: zekoPayload.amount,
    asset: zekoPayload.asset,
    payer: zekoPayload.payer,
    payTo: zekoPayload.payTo,
    sessionId: zekoPayload.sessionId,
    turnId: zekoPayload.turnId,
    resource: required.resource,
    networkId: zekoPayload.networkId,
    now: "2026-04-23T12:31:00.000Z"
  });
  assert.equal(zekoSettlement.duplicate, false);
  assert.equal(zekoSettlement.remainingBudget, "0.485");

  const evmPayloadWithoutDigest = {
    protocol: "x402",
    version: "2",
    requestId: required.requestId,
    paymentId: "pay_demo_evm_001",
    scheme: "exact",
    settlementRail: "evm",
    networkId: evmOption.network,
    asset: evmOption.asset,
    amount: evmOption.amount,
    payer: "0x2222222222222222222222222222222222222222",
    payTo: evmOption.payTo,
    sessionId: context.sessionId,
    turnId: context.turnId,
    issuedAtIso: "2026-04-23T12:00:00.000Z",
    expiresAtIso: "2099-01-01T00:00:00.000Z"
  };
  const evmPayload = assertPaymentPayload({
    ...evmPayloadWithoutDigest,
    authorizationDigest: buildAuthorizationDigest(evmPayloadWithoutDigest)
  });
  const evmVerification = verifyPayment({
    requirements: required,
    payload: evmPayload,
    duplicate: false,
    now: Date.parse("2026-04-23T12:30:00.000Z")
  });
  assert.equal(evmVerification.ok, true);
  assert.equal(evmVerification.settlementRail, "evm");

  const evmSettlement = evmLedger.settle({
    paymentId: evmPayload.paymentId,
    requestId: evmPayload.requestId,
    settlementRail: evmPayload.settlementRail,
    amount: evmPayload.amount,
    asset: evmPayload.asset,
    payer: evmPayload.payer,
    payTo: evmPayload.payTo,
    sessionId: evmPayload.sessionId,
    turnId: evmPayload.turnId,
    resource: required.resource,
    networkId: evmPayload.networkId,
    settlementReference: "0xsettlementreference"
  });
  assert.equal(evmSettlement.duplicate, false);
  assert.equal(evmSettlement.remainingBudget, "0.5");

  const evmReplay = evmLedger.settle({
    paymentId: evmPayload.paymentId,
    requestId: evmPayload.requestId,
    settlementRail: evmPayload.settlementRail,
    amount: evmPayload.amount,
    asset: evmPayload.asset,
    payer: evmPayload.payer,
    payTo: evmPayload.payTo,
    sessionId: evmPayload.sessionId,
    turnId: evmPayload.turnId,
    resource: required.resource,
    networkId: evmPayload.networkId
  });
  assert.equal(evmReplay.duplicate, true);
  assert.equal(evmReplay.remainingBudget, "0.5");

  const settlementResponse = buildSettlementResponse({
    payload: evmPayload,
    duplicate: evmReplay.duplicate,
    eventIds: evmReplay.settlement.eventIds,
    settledAtIso: evmReplay.settlement.settledAtIso,
    remainingBudget: evmReplay.remainingBudget,
    sponsoredBudget: evmReplay.sponsoredBudget,
    budgetAsset: evmReplay.budgetAsset,
    proofBundleUrl: context.proofBundleUrl,
    verifyUrl: context.verifyUrl,
    settlementModel: evmOption.settlementModel,
    evm: evmOption.extensions.evm
  });
  assert.equal(settlementResponse.settlementState, "replayed");
  assert.equal(settlementResponse.payToBudget.budgetAsset.symbol, "USDC");
  assert.equal(typeof settlementResponse.receiptDigest.sha256Hex, "string");
});

test("builds concrete settlement intents for the chosen Zeko and Base targets", () => {
  const zekoIntent = buildZekoExactSettlementIntent({
    contractAddress: "B62qcontract11111111111111111111111111111111111111111111111111111",
    beneficiaryAddress: "B62qbeneficiary1111111111111111111111111111111111111111111111111",
    payerAddress: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    requestId: "req_demo_001",
    paymentId: "pay_demo_001",
    paymentContextDigest: "ctx_demo_001",
    amountMina: "0.015"
  });
  assert.equal(zekoIntent.primitive, "zeko-exact-settlement-zkapp-v1");
  assert.equal(zekoIntent.accountUpdates[0].asset.symbol, "tMINA");
  assert.equal(zekoIntent.accountUpdates[0].to, "B62qcontract11111111111111111111111111111111111111111111111111111");
  assert.equal(zekoIntent.accountUpdates[1].method, "settleExact");

  const zekoFallback = buildZekoNativeTransferFallbackIntent({
    from: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    to: "B62qcontract11111111111111111111111111111111111111111111111111111",
    amountMina: "0.015"
  });
  assert.equal(zekoFallback.primitive, "zeko-native-payment-v1");
  assert.equal(zekoFallback.graphql.operationName, "SendPayment");

  const evmExact = buildBaseUsdcExactEip3009Intent({
    from: "0x2222222222222222222222222222222222222222",
    to: "0x1111111111111111111111111111111111111111",
    amount: "0.50",
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.equal(evmExact.primitive, "evm-base-usdc-exact-eip3009-v1");
  assert.equal(evmExact.typedData.domain.name, "USD Coin");
  assert.equal(evmExact.typedData.domain.version, "2");
  assert.equal(evmExact.typedData.domain.verifyingContract, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

  const evmGateway = buildBaseUsdcCircleGatewayIntent({
    from: "0x2222222222222222222222222222222222222222",
    to: "0x1111111111111111111111111111111111111111",
    amount: "0.50",
    verifyingContract: "0x3333333333333333333333333333333333333333",
    nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  assert.equal(evmGateway.primitive, "evm-base-usdc-circle-gateway-v1");
  assert.equal(evmGateway.typedData.domain.name, "GatewayWalletBatched");
  assert.equal(evmGateway.paymentPayloadShape.payload.authorization.nonce, evmGateway.typedData.message.nonce);
});

test("offers a Circle Gateway-flavored Base rail when batching is desired", () => {
  const gatewayRail = buildBaseMainnetUsdcRail({
    amount: "0.50",
    payTo: "0x1111111111111111111111111111111111111111"
  });
  assert.equal(gatewayRail.extensions.evm.transferMethod, "EIP-3009");

  const circleRail = buildCircleGatewayBaseUsdcRail({
    amount: "0.50",
    payTo: "0x1111111111111111111111111111111111111111"
  });
  assert.equal(circleRail.settlementModel, "circle-gateway-batched");
  assert.equal(circleRail.extensions.evm.typedDataDomainName, "GatewayWalletBatched");
});

test("round-trips base64 JSON headers", () => {
  const required = buildPaymentRequired(sampleContext());
  const encoded = encodeBase64Json(required);

  assert.deepEqual(decodeBase64Json(encoded), required);
});

test("builds signed payment payloads and talks to an HTTP facilitator", async () => {
  const context = sampleContext();
  const required = buildPaymentRequired(context);
  const evmOption = required.accepts.find((option) => option.settlementRail === "evm");
  const evmIntent = buildBaseUsdcExactEip3009Intent({
    from: "0x2222222222222222222222222222222222222222",
    to: evmOption.payTo,
    amount: evmOption.amount,
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  const authorization = buildSignedEvmAuthorization(evmIntent, {
    signature: "0xsignedauthorization"
  });
  const payload = buildSignedPaymentPayload({
    requestId: required.requestId,
    paymentId: "pay_demo_facilitator_001",
    option: evmOption,
    payer: "0x2222222222222222222222222222222222222222",
    sessionId: context.sessionId,
    turnId: context.turnId,
    authorization
  });
  const calls = [];
  const facilitator = new HTTPFacilitatorClient({
    baseUrl: "https://facilitator.example",
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(init.body)
      });
      const responseBody = url.endsWith("/verify")
        ? { ok: true, isValid: true }
        : { ok: true, settled: true, txHash: "0xsettled" };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await facilitator.verifyAndSettle({
    paymentPayload: payload,
    paymentRequirements: required
  });

  assert.equal(result.verification.ok, true);
  assert.equal(result.settlement.txHash, "0xsettled");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://facilitator.example/verify");
  assert.equal(calls[0].body.paymentPayload.authorization.signature, "0xsignedauthorization");
  assert.equal(calls[0].body.paymentRequirements.accepts[0].description, undefined);
});

test("submits signed Zeko native payments and signed zkapp commands", async () => {
  const fetchCalls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    fetchCalls.push(body);
    const responseBody = body.query.includes("sendPayment")
      ? {
          data: {
            sendPayment: {
              payment: {
                hash: "5Jpaymenthash",
                nonce: "7"
              }
            }
          }
        }
      : {
          data: {
            sendZkapp: {
              zkapp: {
                hash: "5Jzkapphash",
                id: "zkapp_001",
                failureReason: {
                  failures: []
                }
              }
            }
          }
        };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const nativeIntent = buildZekoNativeTransferFallbackIntent({
    from: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    to: "B62qcontract11111111111111111111111111111111111111111111111111111",
    amountMina: "0.015"
  });
  const nativeAuthorization = buildSignedZekoNativePaymentAuthorization(nativeIntent, {
    paymentInput: {
      ...nativeIntent.graphql.variables.input,
      nonce: "7"
    },
    rawSignature: "signed_native_payment"
  });
  const nativeSubmission = await submitZekoAuthorization(nativeAuthorization, { fetchImpl });

  assert.equal(nativeSubmission.kind, "payment");
  assert.equal(nativeSubmission.hash, "5Jpaymenthash");
  assert.equal(fetchCalls[0].variables.signature.rawSignature, "signed_native_payment");

  const zkappIntent = buildZekoExactSettlementIntent({
    contractAddress: "B62qcontract11111111111111111111111111111111111111111111111111111",
    beneficiaryAddress: "B62qbeneficiary1111111111111111111111111111111111111111111111111",
    payerAddress: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    requestId: "req_demo_002",
    paymentId: "pay_demo_002",
    paymentContextDigest: "ctx_demo_002",
    amountMina: "0.015"
  });
  const zkappAuthorization = buildSignedZekoZkappAuthorization(zkappIntent, {
    zkappCommand: {
      feePayer: {
        authorization: "signed_fee_payer"
      },
      accountUpdates: []
    }
  });
  const zkappSubmission = await submitZekoAuthorization(zkappAuthorization, { fetchImpl });

  assert.equal(zkappSubmission.kind, "zkapp");
  assert.equal(zkappSubmission.hash, "5Jzkapphash");
  assert.equal(fetchCalls[1].variables.zkappCommandInput.feePayer.authorization, "signed_fee_payer");
});

test("prepares a signed Zeko settlement authorization with injected o1js primitives", async () => {
  const calls = [];
  const fakeTransaction = {
    async prove() {
      calls.push("prove");
    },
    sign(keys) {
      calls.push(["sign", keys.map((entry) => entry.value)]);
    },
    toJSON() {
      return {
        feePayer: {
          authorization: "signed_fee_payer"
        },
        accountUpdates: [{ body: { publicKey: "B62qcontract11111111111111111111111111111111111111111111111111111" } }]
      };
    }
  };
  const fakeO1js = {
    PrivateKey: {
      fromBase58(value) {
        return {
          value,
          toPublicKey() {
            return {
              value: `pub:${value}`,
              toBase58() {
                return `pub:${value}`;
              }
            };
          }
        };
      }
    },
    PublicKey: {
      fromBase58(value) {
        return {
          value,
          toBase58() {
            return value;
          }
        };
      }
    },
    UInt64: {
      from(value) {
        return value;
      }
    },
    AccountUpdate: {
      createSigned(sender) {
        return {
          send({ to, amount }) {
            calls.push(["send", sender.toBase58(), to.toBase58(), amount]);
          }
        };
      }
    },
    fetchAccount: async ({ publicKey }) => {
      calls.push(["fetchAccount", publicKey.toBase58()]);
      return {
        account: {
          nonce: {
            toString() {
              return "0";
            }
          }
        }
      };
    },
    Mina: {
      Network(config) {
        return config;
      },
      setActiveInstance(network) {
        calls.push(["network", network.networkId]);
      },
      async transaction(config, body) {
        calls.push(["transaction", config.memo]);
        await body();
        return fakeTransaction;
      }
    }
  };
  const intent = buildZekoExactSettlementIntent({
    contractAddress: "B62qcontract11111111111111111111111111111111111111111111111111111",
    beneficiaryAddress: "B62qbeneficiary1111111111111111111111111111111111111111111111111",
    payerAddress: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    requestId: "req_demo_003",
    paymentId: "pay_demo_003",
    paymentContextDigest: buildPaymentContextDigest({
      requestId: "req_demo_003",
      paymentId: "pay_demo_003",
      settlementRail: "zeko",
      networkId: "zeko:testnet",
      asset: { symbol: "tMINA", decimals: 9, standard: "native" },
      amount: "0.015",
      payer: "B62qpayer1111111111111111111111111111111111111111111111111111111",
      payTo: "B62qcontract11111111111111111111111111111111111111111111111111111",
      sessionId: "session_demo",
      turnId: "turn_001",
      issuedAtIso: "2026-04-23T12:00:00.000Z",
      expiresAtIso: "2099-01-01T00:00:00.000Z"
    }),
    amountMina: "0.015"
  });

  const authorization = await prepareSignedZekoSettlementAuthorization(intent, {
    senderPrivateKey: "EKFakesender1111111111111111111111111111111111111111111111111111",
    loadO1js: async () => fakeO1js,
    applyContractCall: async ({ settlementUpdate, contractAddress }) => {
      calls.push(["applyContractCall", settlementUpdate.method, contractAddress.toBase58()]);
    }
  });

  assert.equal(authorization.primitive, "zeko-exact-settlement-zkapp-v1");
  assert.equal(authorization.submission.operationName, "sendZkapp");
  assert.equal(authorization.zkappCommand.feePayer.authorization, "signed_fee_payer");
  assert.equal(calls.some((entry) => entry === "prove"), true);
});

test("prepares a signed Zeko settlement authorization through the default settlement contract hook", async () => {
  const calls = [];
  function fakeField(value) {
    return {
      value: String(value),
      toString() {
        return String(value);
      }
    };
  }
  class FakeMerkleMap {
    constructor() {
      this.entries = new Map();
    }

    set(key, value) {
      this.entries.set(String(key), String(value));
    }

    getRoot() {
      return fakeField(
        `root:${[...this.entries.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}`)
          .join(",")}`
      );
    }

    getWitness(key) {
      return {
        witnessKey: String(key)
      };
    }
  }
  class FakeSettlementContract {
    constructor(publicKey) {
      this.publicKey = publicKey;
      this.serviceCommitment = {
        get() {
          return fakeField("service_commitment_field");
        }
      };
    }

    static async compile() {
      calls.push("compile");
    }

    async [X402_SETTLEMENT_METHOD](requestIdHash, paymentIdHash, payer, beneficiary, amountNanomina, paymentContextDigest, resourceDigest, witness) {
      calls.push([
        X402_SETTLEMENT_METHOD,
        requestIdHash.toString(),
        paymentIdHash.toString(),
        payer.toBase58(),
        beneficiary.toBase58(),
        amountNanomina.value ?? amountNanomina,
        paymentContextDigest.toString(),
        resourceDigest.toString(),
        witness.witnessKey
      ]);
    }
  }
  const fakeTransaction = {
    async prove() {
      calls.push("prove");
    },
    sign(keys) {
      calls.push(["sign", keys.map((entry) => entry.value)]);
    },
    toJSON() {
      return {
        feePayer: {
          authorization: "signed_fee_payer_default_hook"
        },
        accountUpdates: []
      };
    }
  };
  const fakeO1js = {
    Field: fakeField,
    Poseidon: {
      hash(values) {
        return fakeField(`poseidon:${values.map((entry) => entry?.toString?.() ?? String(entry)).join("|")}`);
      }
    },
    MerkleMap: FakeMerkleMap,
    PrivateKey: {
      fromBase58(value) {
        return {
          value,
          toPublicKey() {
            return {
              value: `pub:${value}`,
              toBase58() {
                return `pub:${value}`;
              },
              toFields() {
                return [fakeField(`pk:${value}:0`), fakeField(`pk:${value}:1`)];
              }
            };
          }
        };
      }
    },
    PublicKey: {
      fromBase58(value) {
        return {
          value,
          toBase58() {
            return value;
          },
          toFields() {
            return [fakeField(`pk:${value}:0`), fakeField(`pk:${value}:1`)];
          }
        };
      }
    },
    UInt64: {
      from(value) {
        return {
          value: String(value),
          toString() {
            return String(value);
          }
        };
      }
    },
    AccountUpdate: {
      createSigned(sender) {
        return {
          send({ to, amount }) {
            calls.push(["send", sender.toBase58(), to.toBase58(), amount.value ?? amount]);
          }
        };
      }
    },
    fetchAccount: async ({ publicKey }) => {
      calls.push(["fetchAccount", publicKey.toBase58()]);
      return { account: { nonce: { toString: () => "0" } } };
    },
    Mina: {
      Network(config) {
        return config;
      },
      setActiveInstance(network) {
        calls.push(["network", network.networkId]);
      },
      async transaction(config, body) {
        calls.push(["transaction", config.memo]);
        await body();
        return fakeTransaction;
      }
    }
  };
  const intent = buildZekoExactSettlementIntent({
    contractAddress: "B62qcontract11111111111111111111111111111111111111111111111111111",
    beneficiaryAddress: "B62qbeneficiary1111111111111111111111111111111111111111111111111",
    payerAddress: "B62qpayer1111111111111111111111111111111111111111111111111111111",
    requestId: "req_demo_004",
    paymentId: "pay_demo_004",
    paymentContextDigest: "ctx_demo_004",
    resourceDigest: "resource_demo_004",
    amountMina: "0.015"
  });

  const authorization = await prepareSignedZekoSettlementAuthorization(intent, {
    senderPrivateKey: "EKFakesender2222222222222222222222222222222222222222222222222222",
    loadO1js: async () => fakeO1js,
    settlementContract: {
      ContractClass: FakeSettlementContract,
      inMemoryWitnessState: {
        entries: []
      }
    }
  });

  assert.equal(authorization.primitive, "zeko-exact-settlement-zkapp-v1");
  assert.equal(authorization.zkappCommand.feePayer.authorization, "signed_fee_payer_default_hook");
  assert.equal(typeof authorization.settlementWitnessUpdate.paymentKey, "string");
  assert.equal(typeof authorization.settlementWitnessUpdate.paymentLeaf, "string");
  assert.equal(authorization.settlementWitnessUpdate.serviceCommitment, "service_commitment_field");
  assert.equal(calls.includes("compile"), true);
  assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === X402_SETTLEMENT_METHOD), true);
  assert.equal(calls.some((entry) => entry === "prove"), true);
});

test("persists settlement witness updates and serves them through file-backed and HTTP providers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "zeko-x402-"));
  const statePath = path.join(tmpDir, "settlement-state.json");
  function fakeField(value) {
    return {
      value: String(value),
      toString() {
        return String(value);
      }
    };
  }
  function fakeBool(value) {
    return {
      value: Boolean(value),
      toBoolean() {
        return Boolean(value);
      },
      toString() {
        return this.value ? "1" : "0";
      }
    };
  }
  class FakeMerkleMapWitness {
    constructor(isLefts, siblings) {
      this.isLefts = isLefts;
      this.siblings = siblings;
    }
  }
  class FakeMerkleMap {
    constructor() {
      this.entries = new Map();
    }

    set(key, value) {
      this.entries.set(String(key), String(value));
    }

    getRoot() {
      return fakeField(
        `root:${[...this.entries.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}`)
          .join(",")}`
      );
    }

    getWitness(key) {
      return new FakeMerkleMapWitness([fakeBool(true)], [fakeField(`sib:${String(key)}`)]);
    }
  }
  const fakeO1js = {
    Field: fakeField,
    Bool: fakeBool,
    MerkleMap: FakeMerkleMap,
    MerkleMapWitness: FakeMerkleMapWitness
  };

  await persistSettlementWitnessUpdate(
    statePath,
    {
      paymentKey: "123",
      paymentLeaf: "999"
    },
    {
      requestId: "req_demo_005",
      paymentId: "pay_demo_005",
      txHash: "5Jdemo"
    }
  );

  const store = await readSettlementStore(statePath);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].txHash, "5Jdemo");

  const fileProvider = createFileBackedSettlementWitnessProvider({ statePath });
  const fileWitnessInfo = await fileProvider({
    o1js: fakeO1js,
    paymentKey: "123"
  });
  const serializedWitness = serializeMerkleMapWitness(fileWitnessInfo.witness);
  const deserializedWitness = deserializeMerkleMapWitness(fakeO1js, serializedWitness);

  assert.equal(fileWitnessInfo.currentRoot.toString(), "root:123=999");
  assert.equal(deserializedWitness.siblings[0].toString(), "sib:123");
  const server = createSettlementWitnessHttpServer({
    statePath,
    loadO1js: async () => fakeO1js
  });
  assert.equal(typeof server.listen, "function");

  const httpProvider = createHttpSettlementWitnessProvider({
    baseUrl: "https://witness.example",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          currentRoot: "root:123=999",
          witness: serializedWitness
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
  });
  const httpWitnessInfo = await httpProvider({
    o1js: fakeO1js,
    paymentKey: "123"
  });

  assert.equal(httpWitnessInfo.currentRoot, "root:123=999");
  assert.equal(httpWitnessInfo.witness.siblings[0].toString(), "sib:123");
});
