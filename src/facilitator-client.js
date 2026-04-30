import { toAtomicUnits } from "./ledger.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function getFetch(fetchImpl) {
  const resolved = fetchImpl ?? globalThis.fetch;

  if (typeof resolved !== "function") {
    throw new Error("fetch implementation is required.");
  }

  return resolved;
}

export const CDP_X402_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

export const CDP_SUPPORTED_NETWORK_IDS = Object.freeze([
  "eip155:8453",
  "eip155:84532",
  "eip155:137",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
]);

async function parseJsonResponse(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

async function postJson(fetchImpl, url, body, init = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    body: JSON.stringify(body)
  });
  const parsed = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Facilitator request failed (${response.status}): ${typeof parsed?.error === "string" ? parsed.error : JSON.stringify(parsed) || "unknown error"}`
    );
  }

  return parsed;
}

async function getJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      ...(init.headers ?? {})
    }
  });
  const parsed = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Facilitator request failed (${response.status}): ${typeof parsed?.error === "string" ? parsed.error : JSON.stringify(parsed) || "unknown error"}`
    );
  }

  return parsed;
}

function sameAddress(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function sameAsset(left, right) {
  return (
    left?.symbol === right?.symbol &&
    left?.decimals === right?.decimals &&
    (left?.standard ?? null) === (right?.standard ?? null) &&
    (left?.address ?? "").toLowerCase() === (right?.address ?? "").toLowerCase()
  );
}

function findMatchingAcceptedOption(requirements, payload) {
  return Array.isArray(requirements?.accepts)
    ? requirements.accepts.find((option) => (
        option?.scheme === payload?.scheme &&
        option?.network === payload?.networkId &&
        sameAsset(option?.asset, payload?.asset) &&
        option?.amount === payload?.amount &&
        sameAddress(option?.payTo, payload?.payTo)
      ))
    : null;
}

function assertExactEvmAuthorization(payload) {
  const authorization = payload?.authorization;

  if (!isRecord(authorization)) {
    throw new Error("Hosted facilitator integration requires an EVM authorization object.");
  }

  if (!isRecord(authorization.typedData) || !isRecord(authorization.typedData.message)) {
    throw new Error("Hosted facilitator integration requires EVM typedData.message.");
  }

  if (typeof authorization.signature !== "string" || authorization.signature.length === 0) {
    throw new Error("Hosted facilitator integration requires an EVM signature.");
  }

  return authorization;
}

function toHostedExactOption(option) {
  const amount = option?.amount ?? option?.price;

  if (typeof amount !== "string" || amount.length === 0) {
    throw new Error("Hosted facilitator integration requires an exact amount string.");
  }

  if (typeof option?.asset?.address !== "string" || option.asset.address.length === 0) {
    throw new Error("Hosted facilitator integration requires an ERC-20 token address.");
  }

  const extra = {
    name: option?.extensions?.evm?.eip712Name ?? option.asset.symbol,
    version: option?.extensions?.evm?.assetVersion ?? "2",
    ...(typeof option?.settlementModel === "string" ? { settlementModel: option.settlementModel } : {})
  };
  const reserveRelease = option?.extensions?.evm?.reserveRelease;
  const feeSplit = option?.extensions?.evm?.feeSplit;

  if (isRecord(reserveRelease)) {
    extra.reserveRelease = {
      escrowContract: reserveRelease.escrowContract,
      reserveMethod: reserveRelease.reserveMethod,
      releaseMethod: reserveRelease.releaseMethod,
      refundMethod: reserveRelease.refundMethod,
      resultCommitmentType: reserveRelease.resultCommitmentType,
      ...(typeof reserveRelease.expirySeconds === "number"
        ? { expirySeconds: reserveRelease.expirySeconds }
        : {})
    };
  }

  if (isRecord(feeSplit)) {
    const grossAmount = toAtomicUnits(amount, option.asset.decimals);
    const feeBps =
      Number.isInteger(feeSplit.feeBps) && feeSplit.feeBps >= 0 && feeSplit.feeBps <= 10_000
        ? feeSplit.feeBps
        : 0;
    const protocolFeeAmount = (grossAmount * BigInt(feeBps)) / 10_000n;
    const sellerAmount = grossAmount - protocolFeeAmount;
    extra.feeSplit = {
      version: feeSplit.version ?? "protocol-owner-fee-v1",
      feeBps,
      grossAmount: grossAmount.toString(),
      sellerAmount: sellerAmount.toString(),
      protocolFeeAmount: protocolFeeAmount.toString(),
      sellerPayTo: feeSplit.sellerPayTo ?? option.payTo,
      protocolFeePayTo: feeSplit.protocolFeePayTo,
      feeSettlementMode: feeSplit.feeSettlementMode ?? "split-release-v1",
      ...(typeof feeSplit.feePolicyDigest === "string" && feeSplit.feePolicyDigest.length > 0
        ? { feePolicyDigest: feeSplit.feePolicyDigest }
        : {})
    };
  }

  return {
    scheme: option.scheme,
    network: option.network,
    asset: option.asset.address,
    amount: toAtomicUnits(amount, option.asset.decimals).toString(),
    payTo: option.payTo,
    maxTimeoutSeconds: option?.extensions?.evm?.maxTimeoutSeconds ?? 60,
    extra
  };
}

export function buildHostedFacilitatorRequest(input) {
  const option = findMatchingAcceptedOption(input?.paymentRequirements, input?.paymentPayload);

  if (!option) {
    throw new Error("Payment payload does not match any advertised payment requirement.");
  }

  const authorization = assertExactEvmAuthorization(input.paymentPayload);
  const accepted = toHostedExactOption(option);

  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted,
      payload: {
        signature: authorization.signature,
        authorization: authorization.typedData.message,
        ...(isRecord(authorization.settlement) ? { settlement: authorization.settlement } : {}),
        ...(typeof authorization.primitive === "string" ? { primitive: authorization.primitive } : {})
      },
      resource: {
        url: input?.paymentRequirements?.resource,
        description: input?.paymentRequirements?.description,
        mimeType: input?.paymentRequirements?.mimeType
      }
    },
    paymentRequirements: accepted
  };
}

export function stripPaymentRequirements(requirements) {
  if (!isRecord(requirements)) {
    throw new Error("paymentRequirements is required.");
  }

  return {
    protocol: requirements.protocol,
    version: requirements.version,
    requestId: requirements.requestId,
    seller: requirements.seller,
    accepts: Array.isArray(requirements.accepts)
      ? requirements.accepts.map((option) => ({
          scheme: option.scheme,
          settlementRail: option.settlementRail,
          network: option.network,
          asset: option.asset,
          amount: option.amount ?? option.price,
          payTo: option.payTo,
          settlementModel: option.settlementModel,
          ...(isRecord(option.extensions) ? { extensions: option.extensions } : {})
        }))
      : []
  };
}

export class HostedX402FacilitatorClient {
  constructor(input) {
    this.baseUrl = assertNonEmptyString("baseUrl", input?.baseUrl).replace(/\/+$/, "");
    this.fetchImpl = getFetch(input?.fetchImpl);
    this.defaultHeaders = input?.headers ?? {};
    this.bearerToken = typeof input?.bearerToken === "string" ? input.bearerToken : null;
    this.getBearerToken =
      typeof input?.getBearerToken === "function" ? input.getBearerToken : null;
    this.requireAuth = input?.requireAuth === true;
    this.knownSupportedNetworkIds = Array.isArray(input?.knownSupportedNetworkIds)
      ? new Set(input.knownSupportedNetworkIds)
      : null;
    this.enforceKnownNetworks = input?.enforceKnownNetworks !== false;
  }

  async resolveHeaders(input = {}) {
    const token = this.getBearerToken
      ? await this.getBearerToken()
      : this.bearerToken;
    const headers = {
      ...this.defaultHeaders,
      ...(input.headers ?? {})
    };

    if (!headers.Authorization && !headers.authorization && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (this.requireAuth && !headers.Authorization && !headers.authorization) {
      throw new Error("Hosted facilitator requires Authorization bearer token.");
    }

    return headers;
  }

  assertKnownNetwork(paymentPayload) {
    if (!this.enforceKnownNetworks || !this.knownSupportedNetworkIds) {
      return;
    }

    if (!this.knownSupportedNetworkIds.has(paymentPayload?.networkId)) {
      throw new Error(
        `Hosted facilitator at ${this.baseUrl} is not configured for ${paymentPayload?.networkId ?? "unknown network"}.`
      );
    }
  }

  async supported(input = {}) {
    return await getJson(
      this.fetchImpl,
      `${this.baseUrl}/supported`,
      { headers: await this.resolveHeaders(input) }
    );
  }

  async verify(input) {
    this.assertKnownNetwork(input.paymentPayload);
    return await postJson(
      this.fetchImpl,
      `${this.baseUrl}/verify`,
      buildHostedFacilitatorRequest(input),
      { headers: await this.resolveHeaders(input) }
    );
  }

  async settle(input) {
    this.assertKnownNetwork(input.paymentPayload);
    return await postJson(
      this.fetchImpl,
      `${this.baseUrl}/settle`,
      buildHostedFacilitatorRequest(input),
      { headers: await this.resolveHeaders(input) }
    );
  }

  async verifyAndSettle(input) {
    const verification = await this.verify(input);

    if (verification?.isValid === false || verification?.ok === false) {
      return {
        verification,
        settlement: null
      };
    }

    const settlement = await this.settle(input);
    return {
      verification,
      settlement
    };
  }
}

export class CDPFacilitatorClient extends HostedX402FacilitatorClient {
  constructor(input = {}) {
    super({
      ...input,
      baseUrl: input.baseUrl ?? CDP_X402_FACILITATOR_URL,
      knownSupportedNetworkIds: input.knownSupportedNetworkIds ?? CDP_SUPPORTED_NETWORK_IDS,
      requireAuth: input.requireAuth ?? true
    });
  }
}

export class HTTPFacilitatorClient {
  constructor(input) {
    this.baseUrl = assertNonEmptyString("baseUrl", input?.baseUrl).replace(/\/+$/, "");
    this.fetchImpl = getFetch(input?.fetchImpl);
    this.defaultHeaders = input?.headers ?? {};
    this.stripRequirements = input?.stripRequirements !== false;
  }

  async verify(input) {
    return await postJson(
      this.fetchImpl,
      `${this.baseUrl}/verify`,
      {
        paymentPayload: input.paymentPayload,
        paymentRequirements: this.stripRequirements
          ? stripPaymentRequirements(input.paymentRequirements)
          : input.paymentRequirements
      },
      { headers: { ...this.defaultHeaders, ...(input.headers ?? {}) } }
    );
  }

  async settle(input) {
    return await postJson(
      this.fetchImpl,
      `${this.baseUrl}/settle`,
      {
        paymentPayload: input.paymentPayload,
        paymentRequirements: this.stripRequirements
          ? stripPaymentRequirements(input.paymentRequirements)
          : input.paymentRequirements
      },
      { headers: { ...this.defaultHeaders, ...(input.headers ?? {}) } }
    );
  }

  async verifyAndSettle(input) {
    const verification = await this.verify(input);

    if (verification?.isValid === false || verification?.ok === false) {
      return {
        verification,
        settlement: null
      };
    }

    const settlement = await this.settle(input);
    return {
      verification,
      settlement
    };
  }
}
