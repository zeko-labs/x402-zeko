import { canonicalDigest } from "./digest.js";

export const X402_PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const X402_PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const X402_PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export const X402_SETTLEMENT_RAILS = ["zeko", "evm"];

export const X402_SERVICE_FEATURES = [
  "402-response",
  "multi-rail",
  "exact-scheme",
  "duplicate-settlement-protection",
  "proof-bundle-attestation",
  "programmable-privacy",
  "optional-evm-settlement",
  "optional-zeko-settlement",
  "signed-authorization-payloads"
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function inferSettlementRail(networkId) {
  if (typeof networkId !== "string") {
    return undefined;
  }

  if (networkId.startsWith("eip155:")) {
    return "evm";
  }

  if (networkId.startsWith("zeko:")) {
    return "zeko";
  }

  return undefined;
}

export function normalizeAddress(value) {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

export function assertAsset(value) {
  if (!isRecord(value)) {
    throw new Error("asset is required.");
  }

  const decimals = value.decimals;

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("asset.decimals must be an integer between 0 and 18.");
  }

  return {
    symbol: assertNonEmptyString("asset.symbol", value.symbol),
    decimals,
    ...(typeof value.standard === "string" && value.standard.length > 0
      ? { standard: value.standard }
      : {}),
    ...(typeof value.address === "string" && value.address.length > 0
      ? { address: value.address }
      : {})
  };
}

export function sameAsset(left, right) {
  const leftAddress = normalizeAddress(left.address) ?? null;
  const rightAddress = normalizeAddress(right.address) ?? null;

  return (
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    (left.standard ?? null) === (right.standard ?? null) &&
    leftAddress === rightAddress
  );
}

export function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Invalid Base64 JSON payload: ${error.message}` : "Invalid Base64 JSON payload."
    );
  }
}

export function buildAuthorizationDigest(payload) {
  return canonicalDigest(payload).sha256Hex;
}

export function buildPaymentContextDigest(payload) {
  return canonicalDigest({
    requestId: payload.requestId,
    paymentId: payload.paymentId,
    scheme: payload.scheme ?? "exact",
    settlementRail: payload.settlementRail,
    networkId: payload.networkId,
    asset: payload.asset,
    amount: payload.amount,
    payer: payload.payer,
    payTo: payload.payTo,
    sessionId: payload.sessionId,
    ...(typeof payload.turnId === "string" && payload.turnId.length > 0
      ? { turnId: payload.turnId }
      : {}),
    issuedAtIso: payload.issuedAtIso,
    expiresAtIso: payload.expiresAtIso
  }).sha256Hex;
}

export function stripAuthorizationDigest(payload) {
  const { authorizationDigest: _authorizationDigest, ...rest } = payload;
  return rest;
}

function assertAuthorization(value, settlementRail) {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("x402 payment payload authorization must be an object.");
  }

  const authorizationSettlementRail =
    value.settlementRail === "zeko" || value.settlementRail === "evm"
      ? value.settlementRail
      : settlementRail;

  if (authorizationSettlementRail !== settlementRail) {
    throw new Error("x402 payment payload authorization settlementRail must match the payment payload.");
  }

  return {
    ...value,
    primitive: assertNonEmptyString("authorization.primitive", value.primitive),
    settlementRail: authorizationSettlementRail
  };
}

export function assertPaymentPayload(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid x402 payment payload.");
  }

  const turnId = typeof value.turnId === "string" && value.turnId.length > 0 ? value.turnId : undefined;
  const inferredRail = inferSettlementRail(value.networkId);
  const settlementRail =
    value.settlementRail === "zeko" || value.settlementRail === "evm"
      ? value.settlementRail
      : inferredRail;

  if (!settlementRail || !X402_SETTLEMENT_RAILS.includes(settlementRail)) {
    throw new Error("x402 payment payload requires settlementRail=zeko|evm.");
  }

  const authorization = assertAuthorization(value.authorization, settlementRail);

  return {
    protocol: value.protocol === "x402" ? "x402" : (() => {
      throw new Error("x402 payment payload must declare protocol=x402.");
    })(),
    version: value.version === "2" ? "2" : (() => {
      throw new Error("x402 payment payload must declare version=2.");
    })(),
    requestId: typeof value.requestId === "string" && value.requestId.length > 0
      ? value.requestId
      : (() => {
          throw new Error("x402 payment payload requires requestId.");
        })(),
    paymentId: typeof value.paymentId === "string" && value.paymentId.length > 0
      ? value.paymentId
      : (() => {
          throw new Error("x402 payment payload requires paymentId.");
        })(),
    scheme: value.scheme === "exact" ? "exact" : (() => {
      throw new Error("x402 payment payload currently supports only scheme=exact.");
    })(),
    settlementRail,
    networkId: typeof value.networkId === "string" && value.networkId.length > 0
      ? value.networkId
      : (() => {
          throw new Error("x402 payment payload requires networkId.");
        })(),
    asset: assertAsset(value.asset),
    amount: typeof value.amount === "string" && value.amount.length > 0
      ? value.amount
      : (() => {
          throw new Error("x402 payment payload requires amount.");
        })(),
    payer: typeof value.payer === "string" && value.payer.length > 0
      ? value.payer
      : (() => {
          throw new Error("x402 payment payload requires payer.");
        })(),
    payTo: typeof value.payTo === "string" && value.payTo.length > 0
      ? value.payTo
      : (() => {
          throw new Error("x402 payment payload requires payTo.");
        })(),
    sessionId: typeof value.sessionId === "string" && value.sessionId.length > 0
      ? value.sessionId
      : (() => {
          throw new Error("x402 payment payload requires sessionId.");
        })(),
    ...(turnId ? { turnId } : {}),
    issuedAtIso: typeof value.issuedAtIso === "string" && value.issuedAtIso.length > 0
      ? value.issuedAtIso
      : (() => {
          throw new Error("x402 payment payload requires issuedAtIso.");
        })(),
    expiresAtIso: typeof value.expiresAtIso === "string" && value.expiresAtIso.length > 0
      ? value.expiresAtIso
      : (() => {
          throw new Error("x402 payment payload requires expiresAtIso.");
        })(),
    ...(typeof value.paymentContextDigest === "string" && value.paymentContextDigest.length > 0
      ? { paymentContextDigest: value.paymentContextDigest }
      : {}),
    ...(authorization ? { authorization } : {}),
    authorizationDigest: typeof value.authorizationDigest === "string" && value.authorizationDigest.length > 0
      ? value.authorizationDigest
      : (() => {
          throw new Error("x402 payment payload requires authorizationDigest.");
        })()
  };
}

export function buildPaymentPayload(input) {
  const option = isRecord(input.option) ? input.option : isRecord(input.accepted) ? input.accepted : null;
  const issuedAtIso = input.issuedAtIso ?? new Date().toISOString();
  const expiresAtIso =
    input.expiresAtIso ??
    new Date(Date.parse(issuedAtIso) + 1000 * 60 * 15).toISOString();
  const settlementRail =
    input.settlementRail ??
    option?.settlementRail ??
    inferSettlementRail(input.networkId ?? option?.network);
  const authorization = assertAuthorization(input.authorization, settlementRail);
  const payloadWithoutDigest = {
    protocol: "x402",
    version: "2",
    requestId: input.requestId,
    paymentId: input.paymentId,
    scheme: input.scheme ?? option?.scheme ?? "exact",
    settlementRail,
    networkId: input.networkId ?? option?.network,
    asset: input.asset ?? option?.asset,
    amount: input.amount ?? option?.amount ?? option?.price,
    payer: input.payer,
    payTo: input.payTo ?? option?.payTo,
    sessionId: input.sessionId,
    ...(typeof input.turnId === "string" && input.turnId.length > 0 ? { turnId: input.turnId } : {}),
    issuedAtIso,
    expiresAtIso,
    paymentContextDigest:
      input.paymentContextDigest ??
      buildPaymentContextDigest({
        requestId: input.requestId,
        paymentId: input.paymentId,
        scheme: input.scheme ?? option?.scheme ?? "exact",
        settlementRail,
        networkId: input.networkId ?? option?.network,
        asset: input.asset ?? option?.asset,
        amount: input.amount ?? option?.amount ?? option?.price,
        payer: input.payer,
        payTo: input.payTo ?? option?.payTo,
        sessionId: input.sessionId,
        ...(typeof input.turnId === "string" && input.turnId.length > 0 ? { turnId: input.turnId } : {}),
        issuedAtIso,
        expiresAtIso
      }),
    ...(authorization ? { authorization } : {})
  };

  return assertPaymentPayload({
    ...payloadWithoutDigest,
    authorizationDigest: buildAuthorizationDigest(payloadWithoutDigest)
  });
}
