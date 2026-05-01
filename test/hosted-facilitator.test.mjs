import assert from "node:assert/strict";
import test from "node:test";

import {
  CDPFacilitatorClient,
  ETHEREUM_MAINNET_USDC,
  buildBaseMainnetUsdcRail,
  buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail,
  buildBaseMainnetUsdcReserveReleaseFeeRail,
  buildBaseMainnetUsdcReserveReleaseRail,
  buildBaseUsdcExactEip3009Intent,
  buildBaseUsdcReserveReleaseFeeOnReserveIntent,
  buildBaseUsdcReserveReleaseFeeIntent,
  buildBaseUsdcReserveReleaseIntent,
  buildEthereumMainnetUsdcReserveReleaseRail,
  buildEthereumMainnetUsdcExactEip3009Intent,
  buildEthereumUsdcReserveReleaseIntent,
  buildEthereumMainnetUsdcRail,
  buildHostedFacilitatorRequest,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSignedEvmAuthorization
} from "../src/index.js";

function sampleContext(rail) {
  return {
    serviceId: "zeko-x402-test",
    baseUrl: "https://service.example",
    proofBundleUrl: "https://service.example/proof-bundle",
    verifyUrl: "https://service.example/verify",
    sessionId: "session_demo",
    turnId: "turn_demo",
    rails: [rail]
  };
}

function buildSignedPayload(input) {
  const requirements = buildPaymentRequired(sampleContext(input.rail));
  const option = requirements.accepts[0];
  const authorization = buildSignedEvmAuthorization(input.intent, {
    signature: "0xfeedbeef"
  });
  const payload = buildPaymentPayload({
    requestId: requirements.requestId,
    paymentId: input.paymentId ?? "pay_demo",
    option,
    payer: input.payer,
    sessionId: "session_demo",
    turnId: "turn_demo",
    issuedAtIso: "2026-04-24T12:00:00.000Z",
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    authorization
  });

  return {
    requirements,
    option,
    payload
  };
}

test("builds both Base and Ethereum mainnet USDC rails and intents", () => {
  const baseRail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const ethRail = buildEthereumMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const ethIntent = buildEthereumMainnetUsdcExactEip3009Intent({
    from: "0x1111111111111111111111111111111111111111",
    to: "0x000000000000000000000000000000000000bEEF",
    amount: "1.25"
  });

  assert.equal(baseRail.network, "eip155:8453");
  assert.equal(baseRail.extensions.evm.defaultFacilitator, "cdp");
  assert.equal(ethRail.network, "eip155:1");
  assert.equal(ethRail.extensions.evm.requiresCustomFacilitator, true);
  assert.equal(ethIntent.network.networkId, "eip155:1");
  assert.equal(ethIntent.typedData.domain.verifyingContract, ETHEREUM_MAINNET_USDC.asset.address);
});

test("maps internal Base x402 payloads into hosted facilitator request shape", () => {
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: "0x1111111111111111111111111111111111111111",
    to: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111"
  });
  const request = buildHostedFacilitatorRequest({
    paymentRequirements: requirements,
    paymentPayload: payload
  });

  assert.equal(request.x402Version, 2);
  assert.equal(request.paymentPayload.accepted.network, "eip155:8453");
  assert.equal(
    request.paymentPayload.accepted.asset,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  );
  assert.equal(request.paymentPayload.accepted.extra.name, "USD Coin");
  assert.equal(request.paymentPayload.accepted.extra.version, "2");
  assert.equal(request.paymentPayload.accepted.amount, "500000");
  assert.equal(
    request.paymentPayload.payload.authorization.from,
    "0x1111111111111111111111111111111111111111"
  );
  assert.equal(request.paymentPayload.resource.url, requirements.resource);
});

test("maps reserve-release Base payloads into hosted facilitator request shape with escrow metadata", () => {
  const rail = buildBaseMainnetUsdcReserveReleaseRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999",
    expirySeconds: 1800
  });
  const intent = buildBaseUsdcReserveReleaseIntent({
    from: "0x1111111111111111111111111111111111111111",
    payTo: "0x000000000000000000000000000000000000bEEF",
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_demo_reserve",
    paymentId: "pay_demo_reserve",
    amount: "0.50",
    resultDigest: "proof_result_digest_demo"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111",
    paymentId: "pay_demo_reserve"
  });
  const request = buildHostedFacilitatorRequest({
    paymentRequirements: requirements,
    paymentPayload: payload
  });

  assert.equal(request.paymentPayload.accepted.extra.settlementModel, "x402-base-usdc-reserve-release-v2");
  assert.equal(
    request.paymentPayload.accepted.extra.reserveRelease.escrowContract,
    "0x9999999999999999999999999999999999999999"
  );
  assert.equal(
    request.paymentPayload.payload.settlement.contractAddress,
    "0x9999999999999999999999999999999999999999"
  );
});

test("maps reserve-release Base fee-split payloads into hosted facilitator request shape", () => {
  const rail = buildBaseMainnetUsdcReserveReleaseFeeRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
    feeBps: 100,
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999",
    expirySeconds: 1800
  });
  const intent = buildBaseUsdcReserveReleaseFeeIntent({
    from: "0x1111111111111111111111111111111111111111",
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
    feeBps: 100,
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_demo_fee_reserve",
    paymentId: "pay_demo_fee_reserve",
    amount: "0.50",
    resultDigest: "proof_result_digest_fee_demo"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111",
    paymentId: "pay_demo_fee_reserve"
  });
  const request = buildHostedFacilitatorRequest({
    paymentRequirements: requirements,
    paymentPayload: payload
  });

  assert.equal(request.paymentPayload.accepted.extra.settlementModel, "x402-base-usdc-reserve-release-v3");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.feeBps, 100);
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.grossAmount, "500000");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.sellerAmount, "495000");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.protocolFeeAmount, "5000");
  assert.equal(
    request.paymentPayload.payload.settlement.protocolFeePayTo,
    "0x000000000000000000000000000000000000FaCe"
  );
  assert.equal(request.paymentPayload.payload.settlement.mode, "reserve-release-v3");
});

test("maps reserve-release Base fee-on-reserve payloads into hosted facilitator request shape", () => {
  const rail = buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
    feeBps: 100,
    amount: "0.50",
    escrowContract: "0x9999999999999999999999999999999999999999",
    expirySeconds: 1800
  });
  const intent = buildBaseUsdcReserveReleaseFeeOnReserveIntent({
    from: "0x1111111111111111111111111111111111111111",
    payTo: "0x000000000000000000000000000000000000bEEF",
    protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
    feeBps: 100,
    escrowContract: "0x9999999999999999999999999999999999999999",
    requestId: "req_demo_fee_reserve_v4",
    paymentId: "pay_demo_fee_reserve_v4",
    amount: "0.50",
    resultDigest: "proof_result_digest_fee_v4_demo"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111",
    paymentId: "pay_demo_fee_reserve_v4"
  });
  const request = buildHostedFacilitatorRequest({
    paymentRequirements: requirements,
    paymentPayload: payload
  });

  assert.equal(request.paymentPayload.accepted.extra.settlementModel, "x402-base-usdc-reserve-release-v4");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.feeBps, 100);
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.grossAmount, "500000");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.sellerAmount, "495000");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.protocolFeeAmount, "5000");
  assert.equal(request.paymentPayload.accepted.extra.feeSplit.feeSettlementMode, "fee-on-reserve-v1");
  assert.equal(request.paymentPayload.payload.settlement.mode, "reserve-release-v4");
  assert.equal(
    request.paymentPayload.payload.settlement.reserveMethod,
    "reserveExactWithAuthorizationSplitImmediateFee"
  );
});

test("fee-specific reserve-release builders reject non-positive fee bps", () => {
  assert.throws(
    () =>
      buildBaseMainnetUsdcReserveReleaseFeeRail({
        payTo: "0x000000000000000000000000000000000000bEEF",
        protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
        feeBps: 0,
        amount: "0.50",
        escrowContract: "0x9999999999999999999999999999999999999999"
      }),
    /feeBps must be an integer between 1 and 9999/
  );

  assert.throws(
    () =>
      buildBaseUsdcReserveReleaseFeeIntent({
        from: "0x1111111111111111111111111111111111111111",
        payTo: "0x000000000000000000000000000000000000bEEF",
        protocolFeePayTo: "0x000000000000000000000000000000000000FaCe",
        feeBps: 0,
        escrowContract: "0x9999999999999999999999999999999999999999",
        requestId: "req_demo_fee_invalid",
        paymentId: "pay_demo_fee_invalid",
        amount: "0.50",
        resultDigest: "proof_result_digest_invalid_fee"
      }),
    /feeBps must be an integer between 1 and 9999/
  );
});

test("maps reserve-release Ethereum payloads into hosted facilitator request shape with escrow metadata", () => {
  const rail = buildEthereumMainnetUsdcReserveReleaseRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.75",
    escrowContract: "0x8888888888888888888888888888888888888888",
    expirySeconds: 2400
  });
  const intent = buildEthereumUsdcReserveReleaseIntent({
    from: "0x1111111111111111111111111111111111111111",
    payTo: "0x000000000000000000000000000000000000bEEF",
    escrowContract: "0x8888888888888888888888888888888888888888",
    requestId: "req_demo_eth_reserve",
    paymentId: "pay_demo_eth_reserve",
    amount: "0.75",
    resultDigest: "proof_result_digest_eth"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111",
    paymentId: "pay_demo_eth_reserve"
  });
  const request = buildHostedFacilitatorRequest({
    paymentRequirements: requirements,
    paymentPayload: payload
  });

  assert.equal(
    request.paymentPayload.accepted.extra.settlementModel,
    "x402-ethereum-mainnet-usdc-reserve-release-v2"
  );
  assert.equal(
    request.paymentPayload.accepted.extra.reserveRelease.escrowContract,
    "0x8888888888888888888888888888888888888888"
  );
  assert.equal(request.paymentPayload.accepted.network, "eip155:1");
  assert.equal(
    request.paymentPayload.payload.settlement.contractAddress,
    "0x8888888888888888888888888888888888888888"
  );
});

test("uses the CDP facilitator client for Base-style hosted verify/settle flows", async () => {
  const rail = buildBaseMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildBaseUsdcExactEip3009Intent({
    from: "0x1111111111111111111111111111111111111111",
    to: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111"
  });
  const calls = [];
  const client = new CDPFacilitatorClient({
    bearerToken: "token_demo",
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({
        url,
        headers: init.headers,
        body
      });

      return new Response(
        JSON.stringify(
          url.endsWith("/verify")
            ? { isValid: true, network: "base", payer: payload.payer }
            : { success: true, transaction: "0xtxhashdemo", network: "base" }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
  const result = await client.verifyAndSettle({
    paymentPayload: payload,
    paymentRequirements: requirements
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.cdp.coinbase.com/platform/v2/x402/verify");
  assert.equal(calls[1].url, "https://api.cdp.coinbase.com/platform/v2/x402/settle");
  assert.equal(calls[0].headers.Authorization, "Bearer token_demo");
  assert.equal(calls[0].body.paymentPayload.accepted.network, "eip155:8453");
  assert.equal(result.verification.isValid, true);
  assert.equal(result.settlement.success, true);
});

test("rejects Ethereum mainnet on the default CDP facilitator client", async () => {
  const rail = buildEthereumMainnetUsdcRail({
    payTo: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const intent = buildEthereumMainnetUsdcExactEip3009Intent({
    from: "0x1111111111111111111111111111111111111111",
    to: "0x000000000000000000000000000000000000bEEF",
    amount: "0.50"
  });
  const { requirements, payload } = buildSignedPayload({
    rail,
    intent,
    payer: "0x1111111111111111111111111111111111111111"
  });
  const client = new CDPFacilitatorClient({
    bearerToken: "token_demo",
    fetchImpl: async () => {
      throw new Error("fetch should not be called for unsupported networks");
    }
  });

  await assert.rejects(
    () => client.verify({
      paymentPayload: payload,
      paymentRequirements: requirements
    }),
    /not configured for eip155:1/
  );
});
