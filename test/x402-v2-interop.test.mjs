import assert from "node:assert/strict";
import test from "node:test";

import { decodePaymentResponseHeader as decodePaymentResponseHeaderViaFetch } from "@x402/fetch";
import { createPermit2ApprovalTx, PERMIT2_ADDRESS } from "@x402/evm";
import {
  extractOffersFromPaymentRequired,
  extractPaymentIdentifier,
  extractReceiptFromResponse,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712
} from "@x402/extensions";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { parsePaymentPayload, parsePaymentRequired } from "@x402/core/schemas";

import {
  InMemorySettlementLedger,
  buildBaseMainnetUsdcRail,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSettlementResponse,
  buildSignedOfferReceiptExtensions,
  buildSignedSettlementReceiptExtensions,
  buildX402V2Extensions,
  createEIP712OfferReceiptIssuerFromPrivateKey,
  toX402V2PaymentPayload,
  toX402V2PaymentRequired,
  verifyPayment
} from "../src/index.js";

const OFFER_RECEIPT_KEY = "offer-receipt";

function mergeExtensions(...extensionsList) {
  return extensionsList.reduce((merged, current) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return merged;
    }

    for (const [key, value] of Object.entries(current)) {
      const existing = merged[key];

      if (value && typeof value === "object" && !Array.isArray(value)) {
        merged[key] = {
          ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
          ...value
        };
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }, {});
}

function buildInteropContext() {
  const extensions = buildX402V2Extensions({
    paymentIdentifierRequired: true,
    offerReceipt: {
      offerValiditySeconds: 300
    },
    eip2612GasSponsoring: true,
    erc20ApprovalGasSponsoring: true
  });

  return {
    serviceId: "zeko-x402-interop",
    baseUrl: "https://interop.example",
    proofBundleUrl: "https://interop.example/proof-bundle",
    verifyUrl: "https://interop.example/verify",
    sessionId: "session_interop",
    turnId: "turn_interop",
    extensions,
    rails: [
      buildBaseMainnetUsdcRail({
        payTo: "0x1111111111111111111111111111111111111111",
        amount: "0.50"
      })
    ]
  };
}

test("zeko-x402 payment required and payload parse cleanly with official x402 v2 packages", () => {
  const context = buildInteropContext();
  const internalPaymentRequired = buildPaymentRequired(context);
  const paymentRequired = toX402V2PaymentRequired(internalPaymentRequired);
  const paymentRequiredHeader = encodePaymentRequiredHeader(paymentRequired);
  const requiredValidation = parsePaymentRequired(paymentRequired);
  const option = internalPaymentRequired.accepts[0];
  const internalPayload = buildPaymentPayload({
    requestId: internalPaymentRequired.requestId,
    paymentId: "pay_1234567890abcdef",
    option,
    payer: "0x2222222222222222222222222222222222222222",
    sessionId: context.sessionId,
    turnId: context.turnId,
    extensions: internalPaymentRequired.extensions
  });
  const payload = toX402V2PaymentPayload({
    paymentRequired: internalPaymentRequired,
    paymentPayload: internalPayload
  });
  const payloadValidation = parsePaymentPayload(payload);

  assert.equal(requiredValidation.success, true);
  assert.equal(paymentRequiredHeader.length > 0, true);
  assert.equal(payloadValidation.success, true);
  assert.equal(extractPaymentIdentifier(internalPayload), "pay_1234567890abcdef");
  assert.equal(paymentRequired.extensions["payment-identifier"]?.info?.required, true);
  assert.equal(paymentRequired.extensions.eip2612GasSponsoring.info.version, "1");
  assert.equal(paymentRequired.extensions.erc20ApprovalGasSponsoring.info.version, "1");
});

test("payment-identifier extension drives duplicate settlement protection", () => {
  const context = buildInteropContext();
  const paymentRequired = buildPaymentRequired(context);
  const option = paymentRequired.accepts[0];
  const firstPayload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId: "pay_duplicate_alpha_001",
    paymentIdentifier: "pay_identifier_duplicate_001",
    option,
    payer: "0x2222222222222222222222222222222222222222",
    sessionId: context.sessionId,
    turnId: context.turnId,
    extensions: paymentRequired.extensions
  });
  const replayPayload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId: "pay_duplicate_beta_002",
    paymentIdentifier: "pay_identifier_duplicate_001",
    option,
    payer: "0x2222222222222222222222222222222222222222",
    sessionId: context.sessionId,
    turnId: context.turnId,
    extensions: paymentRequired.extensions
  });
  const ledger = new InMemorySettlementLedger({
    budgetAsset: option.asset,
    sponsoredBudget: "1.00"
  });
  const verification = verifyPayment({
    requirements: paymentRequired,
    payload: firstPayload,
    duplicate: false,
    now: Date.parse("2026-05-10T12:00:00.000Z")
  });
  const firstSettlement = ledger.settle({
    paymentId: firstPayload.paymentId,
    requestId: firstPayload.requestId,
    settlementRail: firstPayload.settlementRail,
    amount: firstPayload.amount,
    asset: firstPayload.asset,
    payer: firstPayload.payer,
    payTo: firstPayload.payTo,
    sessionId: firstPayload.sessionId,
    turnId: firstPayload.turnId,
    resource: paymentRequired.resource,
    networkId: firstPayload.networkId,
    extensions: firstPayload.extensions
  });
  const replaySettlement = ledger.settle({
    paymentId: replayPayload.paymentId,
    requestId: replayPayload.requestId,
    settlementRail: replayPayload.settlementRail,
    amount: replayPayload.amount,
    asset: replayPayload.asset,
    payer: replayPayload.payer,
    payTo: replayPayload.payTo,
    sessionId: replayPayload.sessionId,
    turnId: replayPayload.turnId,
    resource: paymentRequired.resource,
    networkId: replayPayload.networkId,
    extensions: replayPayload.extensions
  });

  assert.equal(verification.ok, true);
  assert.equal(firstSettlement.duplicate, false);
  assert.equal(replaySettlement.duplicate, true);
  assert.equal(firstSettlement.settlement.idempotencyKey, "pay_identifier_duplicate_001");
  assert.equal(replaySettlement.settlement.idempotencyKey, "pay_identifier_duplicate_001");
});

test("signed offers and receipts interoperate with official x402 extractors and verifiers", async () => {
  const context = buildInteropContext();
  const paymentRequired = buildPaymentRequired(context);
  const option = paymentRequired.accepts[0];
  const issuer = createEIP712OfferReceiptIssuerFromPrivateKey({
    privateKey: "0x0123456789012345678901234567890123456789012345678901234567890123",
    chainId: 8453
  });
  const offerExtensions = await buildSignedOfferReceiptExtensions({
    paymentRequired,
    issuer,
    offerValiditySeconds: 300
  });
  const paymentRequiredWithOffers = {
    ...paymentRequired,
    extensions: mergeExtensions(paymentRequired.extensions, offerExtensions)
  };
  const offers = extractOffersFromPaymentRequired(paymentRequiredWithOffers);
  const verifiedOffer = await verifyOfferSignatureEIP712(offers[0]);
  const payload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId: "pay_signed_receipt_001",
    option,
    payer: "0x2222222222222222222222222222222222222222",
    sessionId: context.sessionId,
    turnId: context.turnId,
    extensions: paymentRequired.extensions
  });
  const receiptExtensions = await buildSignedSettlementReceiptExtensions({
    issuer,
    resourceUrl: paymentRequired.resource,
    payload,
    transaction: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  const settlementResponse = buildSettlementResponse({
    payload,
    duplicate: false,
    eventIds: ["evt_offer_receipt_demo"],
    settledAtIso: "2026-05-10T12:00:01.000Z",
    remainingBudget: "0.50",
    sponsoredBudget: "1.00",
    budgetAsset: option.asset,
    proofBundleUrl: context.proofBundleUrl,
    verifyUrl: context.verifyUrl,
    settlementModel: option.settlementModel,
    evm: option.extensions.evm,
    extensions: mergeExtensions(receiptExtensions, {
      [OFFER_RECEIPT_KEY]: {
        ...receiptExtensions[OFFER_RECEIPT_KEY],
        includeTxHash: true
      }
    })
  });
  const paymentResponseHeader = encodePaymentResponseHeader(settlementResponse);
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": paymentResponseHeader
    }
  });
  const extractedReceipt = extractReceiptFromResponse(response);
  assert.ok(extractedReceipt);
  const verifiedReceipt = await verifyReceiptSignatureEIP712(extractedReceipt);
  const decodedResponse = decodePaymentResponseHeaderViaFetch(paymentResponseHeader);

  assert.equal(offers.length, 1);
  assert.equal(verifiedOffer.signer.toLowerCase(), "0x14791697260e4c9a71f18484c9f997b308e59325");
  assert.equal(extractedReceipt.format, "eip712");
  assert.equal(verifiedReceipt.signer.toLowerCase(), "0x14791697260e4c9a71f18484c9f997b308e59325");
  assert.equal(decodedResponse.extensions["offer-receipt"].info.receipt.format, "eip712");
});

test("@x402/evm Permit2 helper stays aligned with zeko-x402 gasless declarations", () => {
  const approvalTx = createPermit2ApprovalTx("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

  assert.equal(approvalTx.to.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(approvalTx.data.toLowerCase().includes(PERMIT2_ADDRESS.slice(2).toLowerCase()), true);
});
