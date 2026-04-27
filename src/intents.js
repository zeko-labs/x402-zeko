import { randomBytes } from "node:crypto";

import { defaultZekoAssetSymbol } from "./facilitator.js";
import { canonicalDigest } from "./digest.js";
import { toAtomicUnits } from "./ledger.js";
import {
  BASE_MAINNET_USDC,
  ETHEREUM_MAINNET_USDC,
  ZEKO_TESTNET_NETWORK
} from "./targets.js";

function shortId(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 10) || "x402";
}

function randomNonceHex() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function toBytes32Hex(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(normalized)
    ? `0x${normalized.toLowerCase()}`
    : `0x${canonicalDigest({ [label]: value }).sha256Hex}`;
}

function transferWithAuthorizationTypes() {
  return {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };
}

export function buildReserveReleaseResultCommitment(input) {
  return `0x${canonicalDigest({
    requestId: input?.requestId ?? null,
    paymentId: input?.paymentId ?? null,
    proofDigest: input?.proofDigest ?? null,
    resultDigest: input?.resultDigest ?? null,
    verifier: input?.verifier ?? null,
    result: input?.result ?? null
  }).sha256Hex}`;
}

function buildZekoSettlementMemo(input) {
  return input.memo ?? `x402:${shortId(input.requestId)}:${shortId(input.paymentId)}`;
}

export function buildZekoExactSettlementIntent(input) {
  if (typeof input?.contractAddress !== "string" || input.contractAddress.length === 0) {
    throw new Error("contractAddress is required.");
  }

  if (typeof input?.beneficiaryAddress !== "string" || input.beneficiaryAddress.length === 0) {
    throw new Error("beneficiaryAddress is required.");
  }

  if (typeof input?.payerAddress !== "string" || input.payerAddress.length === 0) {
    throw new Error("payerAddress is required.");
  }

  if (typeof input?.requestId !== "string" || input.requestId.length === 0) {
    throw new Error("requestId is required.");
  }

  if (typeof input?.paymentId !== "string" || input.paymentId.length === 0) {
    throw new Error("paymentId is required.");
  }

  const networkId = input.networkId ?? ZEKO_TESTNET_NETWORK.networkId;
  const assetSymbol = input.assetSymbol ?? defaultZekoAssetSymbol(networkId);
  const paymentContextDigest = input?.paymentContextDigest ?? input?.authorizationDigest;

  if (typeof paymentContextDigest !== "string" || paymentContextDigest.length === 0) {
    throw new Error("paymentContextDigest is required.");
  }

  const amountMina = input.amountMina ?? "0.015";
  const feeMina = input.feeMina ?? "0.10";
  const amountNanomina = toAtomicUnits(amountMina, 9).toString();
  const feeNanomina = toAtomicUnits(feeMina, 9).toString();
  const resourceDigest =
    input.resourceDigest ??
    canonicalDigest({
      requestId: input.requestId,
      paymentId: input.paymentId,
      resource: input.resource ?? null,
      paymentContextDigest
    }).sha256Hex;

  return {
    primitive: "zeko-exact-settlement-zkapp-v1",
    settlementRail: "zeko",
    network: {
      networkId,
      o1jsNetworkId: input.o1jsNetworkId ?? ZEKO_TESTNET_NETWORK.o1jsNetworkId,
      graphql: input.graphql ?? ZEKO_TESTNET_NETWORK.graphql,
      archive: input.archive ?? ZEKO_TESTNET_NETWORK.archive
    },
    transaction: {
      builder: "o1js",
      kind: "zkapp",
      sender: input.payerAddress,
      feePayer: input.feePayerAddress ?? input.payerAddress,
      feeNanomina,
      memo: buildZekoSettlementMemo(input),
      ...(typeof input.validUntil === "string" && input.validUntil.length > 0
        ? { validUntil: input.validUntil }
        : {})
    },
    accountUpdates: [
      {
        role: "payer-transfer",
        authorization: "signature",
        from: input.payerAddress,
        to: input.contractAddress,
        asset: {
          symbol: assetSymbol,
          decimals: 9,
          standard: "native"
        },
        amountNanomina
      },
      {
        role: "settlement-zkapp",
        authorization: "proof",
        contractAddress: input.contractAddress,
        method: input.methodName ?? "settleExact",
        args: {
          requestId: input.requestId,
          paymentId: input.paymentId,
          payerAddress: input.payerAddress,
          beneficiaryAddress: input.beneficiaryAddress,
          amountNanomina,
          paymentContextDigest,
          resourceDigest,
          ...(typeof input.expiresAtIso === "string" && input.expiresAtIso.length > 0
            ? { expiresAtIso: input.expiresAtIso }
            : {})
        }
      }
    ],
    settlementVerification: {
      uniquenessKey: "paymentId",
      eventType: "x402_exact_settlement_v1",
      expectedEventFields: [
        "requestId",
        "paymentId",
        "payerAddress",
        "beneficiaryAddress",
        "amountNanomina",
        "paymentContextDigest",
        "resourceDigest"
      ]
    }
  };
}

export function buildZekoNativeTransferFallbackIntent(input) {
  if (typeof input?.from !== "string" || input.from.length === 0) {
    throw new Error("from is required.");
  }

  if (typeof input?.to !== "string" || input.to.length === 0) {
    throw new Error("to is required.");
  }

  const amountMina = input.amountMina ?? "0.015";
  const feeMina = input.feeMina ?? "0.10";

  const networkId = input.networkId ?? ZEKO_TESTNET_NETWORK.networkId;

  return {
    primitive: "zeko-native-payment-v1",
    settlementRail: "zeko",
    network: {
      networkId,
      graphql: input.graphql ?? ZEKO_TESTNET_NETWORK.graphql
    },
    graphql: {
      endpoint: input.graphql ?? ZEKO_TESTNET_NETWORK.graphql,
      operationName: "SendPayment",
      query:
        "mutation SendPayment($input: SendPaymentInput!, $signature: SignatureInput) { sendPayment(input: $input, signature: $signature) { payment { hash amount fee from to nonce } } }",
      variables: {
        input: {
          from: input.from,
          to: input.to,
          amount: toAtomicUnits(amountMina, 9).toString(),
          fee: toAtomicUnits(feeMina, 9).toString()
        }
      }
    }
  };
}

function buildExactEip3009Intent(target, input) {
  if (typeof input?.from !== "string" || input.from.length === 0) {
    throw new Error("from is required.");
  }

  if (typeof input?.to !== "string" || input.to.length === 0) {
    throw new Error("to is required.");
  }

  const amount = input.amount ?? "0.50";
  const value = toAtomicUnits(amount, target.asset.decimals).toString();
  const domainVersion = input.domainVersion ?? "2";
  const validBeforeUnix =
    input.validBeforeUnix ??
    String(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 5);
  const nonce = input.nonce ?? randomNonceHex();

  return {
    primitive: input.primitive,
    settlementRail: "evm",
    network: {
      networkId: target.networkId,
      chainId: target.chainId,
      chainName: target.chainName
    },
    asset: target.asset,
    transferMethod: "EIP-3009",
    facilitator: {
      kind: "x402-http",
      url: input.facilitatorUrl ?? null
    },
    typedData: {
      domain: {
        name: target.eip712Name,
        version: domainVersion,
        chainId: target.chainId,
        verifyingContract: target.asset.address
      },
      primaryType: "TransferWithAuthorization",
      types: transferWithAuthorizationTypes(),
      message: {
        from: input.from,
        to: input.to,
        value,
        validAfter: String(input.validAfterUnix ?? 0),
        validBefore: validBeforeUnix,
        nonce
      }
    }
  };
}

export function buildBaseUsdcExactEip3009Intent(input) {
  return buildExactEip3009Intent(BASE_MAINNET_USDC, {
    ...input,
    primitive: "evm-base-usdc-exact-eip3009-v1"
  });
}

export function buildEthereumMainnetUsdcExactEip3009Intent(input) {
  return buildExactEip3009Intent(ETHEREUM_MAINNET_USDC, {
    ...input,
    primitive: "evm-ethereum-mainnet-usdc-exact-eip3009-v1"
  });
}

export function buildBaseUsdcReserveReleaseIntent(input) {
  if (typeof input?.from !== "string" || input.from.length === 0) {
    throw new Error("from is required.");
  }

  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required.");
  }

  if (typeof input?.escrowContract !== "string" || input.escrowContract.length === 0) {
    throw new Error("escrowContract is required.");
  }

  if (typeof input?.requestId !== "string" || input.requestId.length === 0) {
    throw new Error("requestId is required.");
  }

  if (typeof input?.paymentId !== "string" || input.paymentId.length === 0) {
    throw new Error("paymentId is required.");
  }

  const amount = input.amount ?? "0.50";
  const value = toAtomicUnits(amount, BASE_MAINNET_USDC.asset.decimals).toString();
  const validBeforeUnix =
    input.validBeforeUnix ??
    String(Math.floor(Date.now() / 1000) + 60 * 60);
  const nonce = input.nonce ?? randomNonceHex();
  const requestIdHash = toBytes32Hex(input.requestIdHash ?? input.requestId, "requestIdHash");
  const paymentIdHash = toBytes32Hex(input.paymentIdHash ?? input.paymentId, "paymentIdHash");
  const resultCommitment = toBytes32Hex(
    input.resultCommitment ??
      buildReserveReleaseResultCommitment({
        requestId: input.requestId,
        paymentId: input.paymentId,
        proofDigest: input.proofDigest,
        resultDigest: input.resultDigest,
        verifier: input.verifier,
        result: input.result
      }),
    "resultCommitment"
  );
  const reserveExpiryUnix =
    input.reserveExpiryUnix ??
    String(Math.floor(Date.now() / 1000) + (input.expirySeconds ?? 60 * 60));

  return {
    primitive: "evm-base-usdc-reserve-release-v2",
    settlementRail: "evm",
    network: {
      networkId: BASE_MAINNET_USDC.networkId,
      chainId: BASE_MAINNET_USDC.chainId,
      chainName: BASE_MAINNET_USDC.chainName
    },
    asset: BASE_MAINNET_USDC.asset,
    transferMethod: "EIP-3009",
    facilitator: {
      kind: "evm-reserve-release",
      url: input.facilitatorUrl ?? null
    },
    typedData: {
      domain: {
        name: BASE_MAINNET_USDC.eip712Name,
        version: input.domainVersion ?? "2",
        chainId: BASE_MAINNET_USDC.chainId,
        verifyingContract: BASE_MAINNET_USDC.asset.address
      },
      primaryType: "TransferWithAuthorization",
      types: transferWithAuthorizationTypes(),
      message: {
        from: input.from,
        to: input.escrowContract,
        value,
        validAfter: String(input.validAfterUnix ?? 0),
        validBefore: validBeforeUnix,
        nonce
      }
    },
    settlement: {
      mode: "reserve-release-v2",
      contractAddress: input.escrowContract,
      tokenAddress: BASE_MAINNET_USDC.asset.address,
      payTo: input.payTo,
      requestIdHash,
      paymentIdHash,
      resultCommitment,
      reserveExpiryUnix: String(reserveExpiryUnix),
      reserveMethod: input.reserveMethod ?? "reserveExactWithAuthorization",
      releaseMethod: input.releaseMethod ?? "releaseReservedPayment",
      refundMethod: input.refundMethod ?? "refundExpiredPayment"
    }
  };
}

export function buildBaseUsdcReleaseReservationCall(input) {
  if (typeof input?.escrowContract !== "string" || input.escrowContract.length === 0) {
    throw new Error("escrowContract is required.");
  }

  return {
    primitive: "evm-base-usdc-reserve-release-call-v2",
    network: {
      networkId: BASE_MAINNET_USDC.networkId,
      chainId: BASE_MAINNET_USDC.chainId,
      chainName: BASE_MAINNET_USDC.chainName
    },
    contractAddress: input.escrowContract,
    functionName: input?.releaseMethod ?? "releaseReservedPayment",
    args: [
      toBytes32Hex(input?.requestIdHash ?? input?.requestId, "requestIdHash"),
      toBytes32Hex(input?.paymentIdHash ?? input?.paymentId, "paymentIdHash"),
      toBytes32Hex(input?.resultCommitment, "resultCommitment")
    ]
  };
}

export function buildBaseUsdcRefundReservationCall(input) {
  if (typeof input?.escrowContract !== "string" || input.escrowContract.length === 0) {
    throw new Error("escrowContract is required.");
  }

  return {
    primitive: "evm-base-usdc-refund-reservation-call-v2",
    network: {
      networkId: BASE_MAINNET_USDC.networkId,
      chainId: BASE_MAINNET_USDC.chainId,
      chainName: BASE_MAINNET_USDC.chainName
    },
    contractAddress: input.escrowContract,
    functionName: input?.refundMethod ?? "refundExpiredPayment",
    args: [
      toBytes32Hex(input?.requestIdHash ?? input?.requestId, "requestIdHash"),
      toBytes32Hex(input?.paymentIdHash ?? input?.paymentId, "paymentIdHash")
    ]
  };
}

export function buildBaseUsdcCircleGatewayIntent(input) {
  if (typeof input?.from !== "string" || input.from.length === 0) {
    throw new Error("from is required.");
  }

  if (typeof input?.to !== "string" || input.to.length === 0) {
    throw new Error("to is required.");
  }

  if (typeof input?.verifyingContract !== "string" || input.verifyingContract.length === 0) {
    throw new Error("verifyingContract is required from the selected 402 payment option.");
  }

  const amount = input.amount ?? "0.50";
  const value = toAtomicUnits(amount, BASE_MAINNET_USDC.asset.decimals).toString();
  const validBeforeUnix =
    input.validBeforeUnix ??
    String(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 5);
  const nonce = input.nonce ?? randomNonceHex();

  return {
    primitive: "evm-base-usdc-circle-gateway-v1",
    settlementRail: "evm",
    network: {
      networkId: BASE_MAINNET_USDC.networkId,
      chainId: BASE_MAINNET_USDC.chainId,
      chainName: BASE_MAINNET_USDC.chainName
    },
    asset: BASE_MAINNET_USDC.asset,
    transferMethod: "EIP-3009",
    facilitator: {
      kind: "circle-gateway",
      url: input.facilitatorUrl ?? null
    },
    typedData: {
      domain: {
        name: "GatewayWalletBatched",
        version: "1",
        chainId: BASE_MAINNET_USDC.chainId,
        verifyingContract: input.verifyingContract
      },
      primaryType: "TransferWithAuthorization",
      types: transferWithAuthorizationTypes(),
      message: {
        from: input.from,
        to: input.to,
        value,
        validAfter: String(input.validAfterUnix ?? 0),
        validBefore: validBeforeUnix,
        nonce
      }
    },
    paymentPayloadShape: {
      x402Version: 2,
      payload: {
        authorization: {
          from: input.from,
          to: input.to,
          value,
          validAfter: String(input.validAfterUnix ?? 0),
          validBefore: validBeforeUnix,
          nonce
        },
        signature: "<signed-typed-data>"
      },
      resource: input.resource ?? null,
      accepted: input.acceptedOption ?? null
    },
    constraints: {
      minimumValiditySeconds: 60 * 60 * 24 * 3
    }
  };
}
