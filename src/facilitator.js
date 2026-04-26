import { canonicalDigest } from "./digest.js";
import {
  X402_SERVICE_FEATURES,
  buildAuthorizationDigest,
  sameAsset,
  stripAuthorizationDigest
} from "./protocol.js";

export const X402_CATALOG_ROUTE = "/.well-known/x402.json";
export const X402_RESOURCE_ROUTE = "/api/x402/proof";
export const X402_VERIFY_ROUTE = "/api/x402/verify";
export const X402_SETTLE_ROUTE = "/api/x402/settle";

export function defaultZekoAssetSymbol(networkId) {
  return String(networkId ?? "").toLowerCase().endsWith(":testnet") ? "tMINA" : "MINA";
}

function buildQueryString(sessionId, turnId) {
  const query = new URLSearchParams({ sessionId });

  if (turnId) {
    query.set("turnId", turnId);
  }

  return query.toString();
}

function parseEvmChainId(networkId) {
  if (typeof networkId !== "string" || !networkId.startsWith("eip155:")) {
    return null;
  }

  const [, chainId] = networkId.split(":");
  return chainId ?? null;
}

function normalizeRails(rails) {
  if (!Array.isArray(rails) || rails.length === 0) {
    throw new Error("At least one settlement rail is required.");
  }

  return rails.map((rail) => {
    if (!rail || typeof rail !== "object") {
      throw new Error("Each settlement rail must be an object.");
    }

    return rail;
  });
}

function buildServiceDescriptor(input) {
  const query = buildQueryString(input.sessionId, input.turnId);

  return {
    version: "2",
    catalogUrl: `${input.baseUrl}${X402_CATALOG_ROUTE}?${query}`,
    resourceUrl: `${input.baseUrl}${X402_RESOURCE_ROUTE}?${query}`,
    verifyUrl: `${input.baseUrl}${X402_VERIFY_ROUTE}?${query}`,
    settleUrl: `${input.baseUrl}${X402_SETTLE_ROUTE}?${query}`,
    features: [...X402_SERVICE_FEATURES]
  };
}

function buildAccept(input, rail) {
  return {
    scheme: "exact",
    settlementRail: rail.settlementRail,
    network: rail.network,
    asset: rail.asset,
    price: rail.amount,
    amount: rail.amount,
    payTo: rail.payTo,
    settlementModel: rail.settlementModel,
    description: rail.description ?? input.description ?? "Exact-price access to a paid resource.",
    mimeType: "application/json",
    outputSchema: {
      type: input.outputType ?? "zeko-proof-bundle",
      proofBundleUrl: input.proofBundleUrl,
      verifyUrl: input.verifyUrl
    },
    extensions: rail.extensions ?? {}
  };
}

function findMatchingOption(requirements, payload) {
  return requirements.accepts.find((option) => (
    option.settlementRail === payload.settlementRail &&
    option.network === payload.networkId &&
    option.payTo === payload.payTo &&
    sameAsset(option.asset, payload.asset)
  ));
}

export function exactPriceMina(serviceTier = "private") {
  if (serviceTier === "fast") {
    return "0.010";
  }

  if (serviceTier === "verified") {
    return "0.020";
  }

  if (serviceTier === "governed") {
    return "0.030";
  }

  return "0.015";
}

export function buildRequestId(input) {
  return `req_${canonicalDigest(input).sha256Hex.slice(0, 24)}`;
}

export function buildZekoRail(input) {
  const networkId = input.networkId;
  const baseExtensions = {
    zeko: {
      programmablePrivacy: input.programmablePrivacy ?? null,
      bundleDigestSha256: input.bundleDigestSha256 ?? null,
      kernelPath: [...(input.kernelPath ?? [])],
      facilitatorMode: input.facilitatorMode ?? "zeko-native"
    }
  };

  return {
    settlementRail: "zeko",
    network: networkId,
    asset: {
      symbol: input.assetSymbol ?? defaultZekoAssetSymbol(networkId),
      decimals: input.decimals ?? 9,
      standard: "native"
    },
    amount: input.amount ?? exactPriceMina(input.serviceTier),
    payTo: input.payTo,
    settlementModel: input.settlementModel ?? "reserve-settle-refund",
    description: input.description ?? "Zeko-native settlement for proof-backed access.",
    extensions: {
      ...baseExtensions,
      ...(input.extensions ?? {}),
      zeko: {
        ...baseExtensions.zeko,
        ...((input.extensions ?? {}).zeko ?? {})
      }
    }
  };
}

export function buildEvmRail(input) {
  const baseExtensions = {
    evm: {
      chainId: input.chainId ?? parseEvmChainId(input.networkId),
      assetAddress: input.tokenAddress ?? null,
      transferMethod: input.transferMethod ?? "permit2",
      facilitatorMode: input.facilitatorMode ?? "evm-facilitated"
    }
  };

  return {
    settlementRail: "evm",
    network: input.networkId,
    asset: {
      symbol: input.assetSymbol ?? "USDC",
      decimals: input.decimals ?? 6,
      standard: input.assetStandard ?? "erc20",
      ...(input.tokenAddress ? { address: input.tokenAddress } : {})
    },
    amount: input.amount,
    payTo: input.payTo,
    settlementModel: input.settlementModel ?? (input.transferMethod ?? "permit2"),
    description: input.description ?? "EVM settlement through an x402-compatible facilitator.",
    extensions: {
      ...baseExtensions,
      ...(input.extensions ?? {}),
      evm: {
        ...baseExtensions.evm,
        ...((input.extensions ?? {}).evm ?? {})
      }
    }
  };
}

export function buildPaymentRequired(input) {
  const descriptor = buildServiceDescriptor(input);
  const rails = normalizeRails(input.rails);
  const accepts = rails.map((rail) => buildAccept(input, rail));
  const requestId = buildRequestId({
    serviceId: input.serviceId,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    resourcePath: X402_RESOURCE_ROUTE,
    accepts: accepts.map((option) => ({
      settlementRail: option.settlementRail,
      network: option.network,
      asset: option.asset,
      amount: option.amount,
      payTo: option.payTo
    }))
  });

  return {
    protocol: "x402",
    version: "2",
    requestId,
    resource: descriptor.resourceUrl,
    description:
      input.description ??
      "Get a Zeko resource through x402 with optional Zeko-native or EVM settlement.",
    mimeType: "application/json",
    seller: {
      serviceId: input.serviceId
    },
    accepts
  };
}

export function buildCatalog(input) {
  const descriptor = buildServiceDescriptor(input);
  const requirements = buildPaymentRequired(input);

  return {
    protocol: "x402",
    version: "2",
    serviceId: input.serviceId,
    resource: {
      chain: "zeko-service",
      serviceNetworkId: input.serviceNetworkId ?? "zeko:testnet"
    },
    facilitator: {
      mode: "multi-rail",
      verifyUrl: descriptor.verifyUrl,
      settleUrl: descriptor.settleUrl
    },
    routes: [
      {
        method: "GET",
        resource: descriptor.resourceUrl,
        description: requirements.description,
        mimeType: requirements.mimeType,
        accepts: requirements.accepts
      }
    ],
    features: [...X402_SERVICE_FEATURES]
  };
}

export function verifyPayment(input) {
  const option = findMatchingOption(input.requirements, input.payload);
  const expectedDigest = buildAuthorizationDigest(stripAuthorizationDigest(input.payload));
  const issuedAt = Date.parse(input.payload.issuedAtIso);
  const expiresAt = Date.parse(input.payload.expiresAtIso);
  const now = input.now ?? Date.now();
  const reason =
    input.payload.requestId !== input.requirements.requestId
      ? "Payment payload requestId does not match the advertised x402 payment requirement."
      : !option
        ? "Payment payload does not match any advertised settlement rail."
        : input.payload.scheme !== option.scheme
          ? "Payment payload scheme does not match the advertised x402 scheme."
          : input.payload.amount !== option.amount
            ? "Payment payload amount does not match the exact advertised price."
            : Number.isNaN(issuedAt)
              ? "Payment payload issuedAtIso is invalid."
              : Number.isNaN(expiresAt)
                ? "Payment payload expiresAtIso is invalid."
                : expiresAt < issuedAt
                  ? "Payment payload expiresAtIso must be after issuedAtIso."
                  : expiresAt < now
                    ? "Payment payload is expired."
                    : expectedDigest !== input.payload.authorizationDigest
                      ? "Payment payload authorizationDigest does not match the canonical payload digest."
                      : undefined;

  const duplicate = Boolean(input.duplicate);
  const ok = !reason;

  return {
    ok,
    duplicate,
    requestId: input.payload.requestId,
    paymentId: input.payload.paymentId,
    settlementRail: input.payload.settlementRail,
    scheme: input.payload.scheme,
    networkId: input.payload.networkId,
    asset: input.payload.asset,
    amount: input.payload.amount,
    payer: input.payload.payer,
    payTo: input.payload.payTo,
    ...(reason ? { reason } : {}),
    settlementState: reason ? "rejected" : duplicate ? "duplicate" : "verifiable"
  };
}

export function buildSettlementResponse(input) {
  const receiptWithoutDigest = {
    ok: true,
    duplicate: input.duplicate,
    requestId: input.payload.requestId,
    paymentId: input.payload.paymentId,
    settlementRail: input.payload.settlementRail,
    networkId: input.payload.networkId,
    asset: input.payload.asset,
    amount: input.payload.amount,
    payer: input.payload.payer,
    payTo: input.payload.payTo,
    settlementState: input.duplicate ? "replayed" : "settled",
    settledAtIso: input.settledAtIso,
    eventIds: [...input.eventIds],
    payToBudget: {
      budgetAsset: input.budgetAsset ?? input.payload.asset,
      sponsoredBudget: input.sponsoredBudget,
      remainingBudget: input.remainingBudget
    },
    proofBundleUrl: input.proofBundleUrl,
    verifyUrl: input.verifyUrl,
    settlement: {
      model: input.settlementModel ?? "unknown",
      ...(input.settlementReference ? { reference: input.settlementReference } : {}),
      ...(input.zeko ? { zeko: input.zeko } : {}),
      ...(input.evm ? { evm: input.evm } : {})
    }
  };

  return {
    ...receiptWithoutDigest,
    receiptDigest: canonicalDigest(receiptWithoutDigest)
  };
}
