import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  createEIP712OfferReceiptIssuer,
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
  declareOfferReceiptExtension,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  validatePaymentIdentifierRequirement
} from "@x402/extensions";
import { privateKeyToAccount } from "viem/accounts";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value) {
  return isRecord(value) ? { ...value } : {};
}

function mergeRecordEntry(target, key, value) {
  if (!isRecord(value)) {
    return;
  }

  const current = isRecord(target[key]) ? target[key] : {};
  target[key] = {
    ...current,
    ...value
  };
}

function mergeRecords(...records) {
  const merged = {};

  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }

    for (const [key, value] of Object.entries(record)) {
      mergeRecordEntry(merged, key, value);
    }
  }

  return merged;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function toAtomicAmount(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid asset decimals: ${decimals}`);
  }

  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid amount: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction || "0")).toString();
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
    sameAddress(left?.address, right?.address)
  );
}

function buildV2AcceptedOption(option) {
  if (!option || typeof option !== "object") {
    throw new Error("accepted option is required.");
  }

  const amount = option.amount ?? option.price;

  if (typeof amount !== "string" || amount.length === 0) {
    throw new Error("accepted option amount is required.");
  }

  return {
    scheme: option.scheme,
    network: option.network,
    amount: toAtomicAmount(amount, option.asset?.decimals ?? 0),
    asset: typeof option?.asset?.address === "string" && option.asset.address.length > 0 ? option.asset.address : "native",
    payTo: option.payTo,
    maxTimeoutSeconds: option?.extensions?.evm?.maxTimeoutSeconds ?? 60,
    extra: {
      settlementRail: option.settlementRail,
      settlementModel: option.settlementModel,
      asset: option.asset,
      description: option.description,
      mimeType: option.mimeType,
      outputSchema: option.outputSchema,
      extensions: option.extensions ?? {}
    }
  };
}

function findAcceptedOption(paymentRequired, paymentPayload) {
  if (!Array.isArray(paymentRequired?.accepts)) {
    return null;
  }

  return paymentRequired.accepts.find((option) => (
    option.scheme === paymentPayload?.scheme &&
    option.network === paymentPayload?.networkId &&
    option.amount === paymentPayload?.amount &&
    sameAddress(option.payTo, paymentPayload?.payTo) &&
    sameAsset(option.asset, paymentPayload?.asset)
  ));
}

export function buildX402V2Extensions(input = {}) {
  const extensions = cloneRecord(input.extensions);

  if (input.paymentIdentifierRequired === true || typeof input.paymentIdentifier === "string") {
    mergeRecordEntry(
      extensions,
      PAYMENT_IDENTIFIER,
      declarePaymentIdentifierExtension(input.paymentIdentifierRequired === true)
    );
  }

  if (input.offerReceipt === true || isRecord(input.offerReceipt)) {
    Object.assign(extensions, declareOfferReceiptExtension(isRecord(input.offerReceipt) ? input.offerReceipt : undefined));
  }

  if (input.eip2612GasSponsoring === true) {
    Object.assign(extensions, declareEip2612GasSponsoringExtension());
  }

  if (input.erc20ApprovalGasSponsoring === true) {
    Object.assign(extensions, declareErc20ApprovalGasSponsoringExtension());
  }

  if (typeof input.paymentIdentifier === "string" && input.paymentIdentifier.length > 0) {
    return withPaymentIdentifierExtension(extensions, input.paymentIdentifier, input.paymentIdentifierRequired === true);
  }

  return extensions;
}

export function toX402V2PaymentRequired(paymentRequired) {
  if (!paymentRequired || typeof paymentRequired !== "object") {
    throw new Error("paymentRequired is required.");
  }

  return {
    x402Version: 2,
    resource: {
      url: paymentRequired.resource,
      ...(typeof paymentRequired.description === "string" ? { description: paymentRequired.description } : {}),
      ...(typeof paymentRequired.mimeType === "string" ? { mimeType: paymentRequired.mimeType } : {})
    },
    accepts: (paymentRequired.accepts ?? []).map((option) => buildV2AcceptedOption(option)),
    ...(isRecord(paymentRequired.extensions) ? { extensions: paymentRequired.extensions } : {})
  };
}

export function toX402V2PaymentPayload(input) {
  const paymentRequired = input?.paymentRequired;
  const paymentPayload = input?.paymentPayload;

  if (!paymentPayload || typeof paymentPayload !== "object") {
    throw new Error("paymentPayload is required.");
  }

  const acceptedOption =
    input?.acceptedOption ??
    findAcceptedOption(paymentRequired, paymentPayload);

  if (!acceptedOption) {
    throw new Error("acceptedOption is required.");
  }

  const accepted = buildV2AcceptedOption(acceptedOption);

  return {
    x402Version: 2,
    accepted,
    payload: {
      requestId: paymentPayload.requestId,
      paymentId: paymentPayload.paymentId,
      paymentContextDigest: paymentPayload.paymentContextDigest,
      authorizationDigest: paymentPayload.authorizationDigest,
      settlementRail: paymentPayload.settlementRail,
      networkId: paymentPayload.networkId,
      payer: paymentPayload.payer,
      payTo: paymentPayload.payTo,
      issuedAtIso: paymentPayload.issuedAtIso,
      expiresAtIso: paymentPayload.expiresAtIso,
      ...(typeof paymentPayload.turnId === "string" ? { turnId: paymentPayload.turnId } : {}),
      ...(isRecord(paymentPayload.authorization) ? { authorization: paymentPayload.authorization } : {}),
      ...(isRecord(paymentPayload.feeAuthorization) ? { feeAuthorization: paymentPayload.feeAuthorization } : {}),
      ...(isRecord(paymentPayload.asset) ? { asset: paymentPayload.asset } : {}),
      ...(typeof paymentPayload.amount === "string" ? { amount: paymentPayload.amount } : {}),
      ...(isRecord(paymentPayload.extensions) ? { extensions: paymentPayload.extensions } : {})
    },
    ...(paymentRequired
      ? {
          resource: {
            url: paymentRequired.resource,
            ...(typeof paymentRequired.description === "string" ? { description: paymentRequired.description } : {}),
            ...(typeof paymentRequired.mimeType === "string" ? { mimeType: paymentRequired.mimeType } : {})
          }
        }
      : {}),
    ...(isRecord(paymentPayload.extensions) ? { extensions: paymentPayload.extensions } : {})
  };
}

export function withPaymentIdentifierExtension(extensions, paymentIdentifier, required = false) {
  if (typeof paymentIdentifier !== "string" || paymentIdentifier.length === 0) {
    return cloneRecord(extensions);
  }

  const merged = mergeRecords(
    {
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(required)
    },
    extensions
  );

  return appendPaymentIdentifierToExtensions(merged, paymentIdentifier);
}

export function resolveX402PaymentIdentifier(payload, validate = true) {
  const paymentIdentifier = extractPaymentIdentifier(payload, validate);

  if (typeof paymentIdentifier === "string" && paymentIdentifier.length > 0) {
    return paymentIdentifier;
  }

  return typeof payload?.paymentId === "string" && payload.paymentId.length > 0 ? payload.paymentId : null;
}

export function validateX402PaymentIdentifier(payload, requirements) {
  const required =
    isRecord(requirements?.extensions?.[PAYMENT_IDENTIFIER]) &&
    requirements.extensions[PAYMENT_IDENTIFIER].info?.required === true;

  return validatePaymentIdentifierRequirement(payload, required);
}

export function createEIP712OfferReceiptIssuerFromPrivateKey(input) {
  if (typeof input?.privateKey !== "string" || input.privateKey.length === 0) {
    throw new Error("privateKey is required.");
  }

  const account = privateKeyToAccount(normalizePrivateKey(input.privateKey));
  const chainId = Number.isInteger(input.chainId) && input.chainId > 0 ? input.chainId : 1;
  const kid =
    typeof input.kid === "string" && input.kid.length > 0
      ? input.kid
      : `did:pkh:eip155:${chainId}:${account.address}#key-1`;

  return createEIP712OfferReceiptIssuer(kid, account.signTypedData.bind(account));
}

export async function buildSignedOfferReceiptExtensions(input) {
  if (!input?.paymentRequired || !Array.isArray(input.paymentRequired.accepts)) {
    throw new Error("paymentRequired.accepts is required.");
  }

  if (!input?.issuer || typeof input.issuer.issueOffer !== "function") {
    throw new Error("issuer.issueOffer is required.");
  }

  const resourceUrl =
    typeof input.resourceUrl === "string" && input.resourceUrl.length > 0
      ? input.resourceUrl
      : input.paymentRequired.resource;

  if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
    throw new Error("resourceUrl is required.");
  }

  const offers = await Promise.all(
    input.paymentRequired.accepts.map((option, acceptIndex) => (
      input.issuer.issueOffer(resourceUrl, {
        acceptIndex,
        scheme: option.scheme,
        network: option.network,
        asset: typeof option?.asset?.address === "string" && option.asset.address.length > 0 ? option.asset.address : "native",
        payTo: option.payTo,
        amount: option.amount ?? option.price,
        ...(typeof input.offerValiditySeconds === "number"
          ? { offerValiditySeconds: input.offerValiditySeconds }
          : {})
      })
    ))
  );

  return {
    "offer-receipt": {
      ...(declareOfferReceiptExtension({
        ...(typeof input.offerValiditySeconds === "number"
          ? { offerValiditySeconds: input.offerValiditySeconds }
          : {}),
        ...(input.includeTxHash === true ? { includeTxHash: true } : {})
      })["offer-receipt"] ?? {}),
      info: {
        offers
      }
    }
  };
}

export async function buildSignedSettlementReceiptExtensions(input) {
  if (!input?.issuer || typeof input.issuer.issueReceipt !== "function") {
    throw new Error("issuer.issueReceipt is required.");
  }

  const resourceUrl =
    typeof input.resourceUrl === "string" && input.resourceUrl.length > 0
      ? input.resourceUrl
      : input?.payload?.resourceUrl;

  if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
    throw new Error("resourceUrl is required.");
  }

  const payer =
    typeof input.payer === "string" && input.payer.length > 0
      ? input.payer
      : input?.payload?.payer;

  if (typeof payer !== "string" || payer.length === 0) {
    throw new Error("payer is required.");
  }

  const network =
    typeof input.network === "string" && input.network.length > 0
      ? input.network
      : input?.payload?.networkId;

  if (typeof network !== "string" || network.length === 0) {
    throw new Error("network is required.");
  }

  const receipt = await input.issuer.issueReceipt(
    resourceUrl,
    payer,
    network,
    typeof input.transaction === "string" && input.transaction.length > 0 ? input.transaction : undefined
  );

  return {
    "offer-receipt": {
      ...(declareOfferReceiptExtension({
        ...(input.includeTxHash === true ? { includeTxHash: true } : {})
      })["offer-receipt"] ?? {}),
      info: {
        receipt
      }
    }
  };
}
