import { createServer } from "node:http";

import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  fallback,
  http,
  parseSignature,
  verifyTypedData
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, mainnet } from "viem/chains";

import { buildHostedFacilitatorRequest } from "./facilitator-client.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function isHexData(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length >= 10;
}

function normalizeRpcUrls(config) {
  const fromArray = Array.isArray(config?.rpcUrls)
    ? config.rpcUrls.filter((value) => typeof value === "string" && value.length > 0)
    : [];
  const fromScalar =
    typeof config?.rpcUrl === "string" && config.rpcUrl.length > 0
      ? [config.rpcUrl]
      : [];
  const rpcUrls = [...new Set([...fromArray, ...fromScalar])];

  if (rpcUrls.length === 0) {
    throw new Error("rpcUrl or rpcUrls is required.");
  }

  return rpcUrls;
}

function parseChainId(networkId) {
  if (typeof networkId !== "string" || !networkId.startsWith("eip155:")) {
    throw new Error(`Unsupported EVM networkId: ${networkId ?? "unknown"}`);
  }

  const [, chainIdText] = networkId.split(":");
  const chainId = Number(chainIdText);

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid EVM chainId in networkId: ${networkId}`);
  }

  return chainId;
}

function getChain(networkId) {
  if (networkId === "eip155:8453") {
    return base;
  }

  if (networkId === "eip155:84532") {
    return baseSepolia;
  }

  if (networkId === "eip155:1") {
    return mainnet;
  }

  return undefined;
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

export const USDC_EIP3009_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "authorizationState",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "transferWithAuthorization",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  }
];

export const X402_RESERVE_RELEASE_ESCROW_ABI = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }]
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }]
  },
  {
    type: "error",
    name: "AccessControlUnauthorizedAccount",
    inputs: [
      { name: "account", type: "address" },
      { name: "neededRole", type: "bytes32" }
    ]
  },
  {
    type: "error",
    name: "EnforcedPause",
    inputs: []
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [{ name: "token", type: "address" }]
  },
  {
    type: "error",
    name: "InvalidToken",
    inputs: [{ name: "token", type: "address" }]
  },
  {
    type: "error",
    name: "ReservationAlreadyExists",
    inputs: [{ name: "reservationKey", type: "bytes32" }]
  },
  {
    type: "error",
    name: "ReservationMissing",
    inputs: [{ name: "reservationKey", type: "bytes32" }]
  },
  {
    type: "error",
    name: "ReservationNotReleasable",
    inputs: [{ name: "reservationKey", type: "bytes32" }]
  },
  {
    type: "error",
    name: "ReservationNotRefundable",
    inputs: [{ name: "reservationKey", type: "bytes32" }]
  },
  {
    type: "error",
    name: "ReservationExpired",
    inputs: [
      { name: "reservationKey", type: "bytes32" },
      { name: "expiry", type: "uint256" }
    ]
  },
  {
    type: "error",
    name: "ResultCommitmentMismatch",
    inputs: [{ name: "reservationKey", type: "bytes32" }]
  },
  {
    type: "error",
    name: "InvalidReservationData",
    inputs: []
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "reserveExactWithAuthorization",
    inputs: [
      { name: "requestIdHash", type: "bytes32" },
      { name: "paymentIdHash", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "payTo", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "resultCommitment", type: "bytes32" },
      { name: "expiry", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "reserveExactWithAuthorizationSplit",
    inputs: [
      { name: "requestIdHash", type: "bytes32" },
      { name: "paymentIdHash", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "sellerPayTo", type: "address" },
      { name: "protocolFeePayTo", type: "address" },
      { name: "token", type: "address" },
      { name: "grossAmount", type: "uint256" },
      { name: "sellerAmount", type: "uint256" },
      { name: "protocolFeeAmount", type: "uint256" },
      { name: "feeBps", type: "uint16" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "resultCommitment", type: "bytes32" },
      { name: "expiry", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "reserveExactWithAuthorizationSplitImmediateFee",
    inputs: [
      { name: "requestIdHash", type: "bytes32" },
      { name: "paymentIdHash", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "sellerPayTo", type: "address" },
      { name: "protocolFeePayTo", type: "address" },
      { name: "token", type: "address" },
      { name: "grossAmount", type: "uint256" },
      { name: "sellerAmount", type: "uint256" },
      { name: "protocolFeeAmount", type: "uint256" },
      { name: "feeBps", type: "uint16" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "resultCommitment", type: "bytes32" },
      { name: "expiry", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "releaseReservedPayment",
    inputs: [
      { name: "requestIdHash", type: "bytes32" },
      { name: "paymentIdHash", type: "bytes32" },
      { name: "resultCommitment", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "refundExpiredPayment",
    inputs: [
      { name: "requestIdHash", type: "bytes32" },
      { name: "paymentIdHash", type: "bytes32" }
    ],
    outputs: []
  }
];

function formatDecodedArg(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => formatDecodedArg(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, formatDecodedArg(entry)])
    );
  }

  return value;
}

function extractErrorData(error, visited = new Set()) {
  if (!error || typeof error !== "object") {
    return null;
  }

  if (visited.has(error)) {
    return null;
  }
  visited.add(error);

  if (isHexData(error.data)) {
    return error.data;
  }

  if (isRecord(error.data)) {
    const nested = extractErrorData(error.data, visited);
    if (nested) {
      return nested;
    }
  }

  if (isRecord(error.error)) {
    const nested = extractErrorData(error.error, visited);
    if (nested) {
      return nested;
    }
  }

  if (isRecord(error.cause)) {
    const nested = extractErrorData(error.cause, visited);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function decodeKnownExecutionError(error) {
  const data = extractErrorData(error);

  if (!data) {
    return null;
  }

  try {
    const decoded = decodeErrorResult({
      abi: X402_RESERVE_RELEASE_ESCROW_ABI,
      data
    });
    const args = Array.isArray(decoded.args)
      ? decoded.args.map((entry) => formatDecodedArg(entry))
      : [];
    const reason =
      decoded.errorName === "Error" && typeof args[0] === "string"
        ? args[0]
        : decoded.errorName === "Panic"
          ? `Solidity panic: ${args[0]}`
          : args.length > 0
            ? `${decoded.errorName}(${args.map((entry) => JSON.stringify(entry)).join(", ")})`
            : decoded.errorName;

    return {
      errorCode: "contract_revert",
      errorName: decoded.errorName,
      errorArgs: args,
      revertData: data,
      reason
    };
  } catch {
    return {
      errorCode: "contract_revert",
      revertData: data
    };
  }
}

function isBytes32Hex(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isReserveReleaseSettlementModel(value) {
  return (
    typeof value === "string" &&
    (
      value.endsWith("-reserve-release-v2") ||
      value.endsWith("-reserve-release-v3") ||
      value.endsWith("-reserve-release-v4")
    )
  );
}

function normalizeHostedRequest(input) {
  if (
    isRecord(input?.paymentPayload) &&
    isRecord(input.paymentPayload.accepted) &&
    isRecord(input.paymentPayload.payload)
  ) {
    return input;
  }

  if (isRecord(input?.paymentPayload) && isRecord(input?.paymentRequirements)) {
    return buildHostedFacilitatorRequest(input);
  }

  throw new Error(
    "Expected a hosted x402 facilitator request or an internal { paymentPayload, paymentRequirements } pair."
  );
}

function normalizeHostedExactPayment(input) {
  const request = normalizeHostedRequest(input);
  const hostedPaymentPayload = request.paymentPayload;
  const accepted = hostedPaymentPayload.accepted;
  const payload = hostedPaymentPayload.payload;
  const authorization = payload.authorization;
  const signature = payload.signature;
  const networkId = assertNonEmptyString("paymentPayload.accepted.network", accepted?.network);
  const chainId = parseChainId(networkId);
  const tokenAddress = assertNonEmptyString("paymentPayload.accepted.asset", accepted?.asset);
  const payTo = assertNonEmptyString("paymentPayload.accepted.payTo", accepted?.payTo);
  const domainName = assertNonEmptyString(
    "paymentPayload.accepted.extra.name",
    accepted?.extra?.name ?? "USD Coin"
  );
  const domainVersion = accepted?.extra?.version ?? "2";

  if (!isRecord(authorization)) {
    throw new Error("paymentPayload.payload.authorization is required.");
  }

  if (typeof signature !== "string" || signature.length === 0) {
    throw new Error("paymentPayload.payload.signature is required.");
  }

  const from = assertNonEmptyString("authorization.from", authorization.from);
  const to = assertNonEmptyString("authorization.to", authorization.to);
  const value = BigInt(assertNonEmptyString("authorization.value", authorization.value));
  const validAfter = BigInt(assertNonEmptyString("authorization.validAfter", authorization.validAfter));
  const validBefore = BigInt(assertNonEmptyString("authorization.validBefore", authorization.validBefore));
  const nonce = assertNonEmptyString("authorization.nonce", authorization.nonce);
  const acceptedAmount = BigInt(assertNonEmptyString("paymentPayload.accepted.amount", accepted.amount));
  const settlementModel =
    typeof accepted?.extra?.settlementModel === "string" ? accepted.extra.settlementModel : null;
  const settlement = isRecord(payload?.settlement) ? payload.settlement : null;
  const reserveReleaseConfig = isRecord(accepted?.extra?.reserveRelease)
    ? accepted.extra.reserveRelease
    : null;
  const feeSplitConfig = isRecord(accepted?.extra?.feeSplit)
    ? accepted.extra.feeSplit
    : null;
  const hasFeeSplit = Boolean(
    feeSplitConfig ||
      settlement?.mode === "reserve-release-v3" ||
      settlement?.mode === "reserve-release-v4"
  );
  const reserveRelease =
    isReserveReleaseSettlementModel(settlementModel) ||
    settlement?.mode === "reserve-release-v2" ||
    settlement?.mode === "reserve-release-v3" ||
    settlement?.mode === "reserve-release-v4"
      ? {
          contractAddress: assertNonEmptyString(
            "paymentPayload.payload.settlement.contractAddress",
            settlement?.contractAddress ?? reserveReleaseConfig?.escrowContract
          ),
          requestIdHash: (() => {
            const value = assertNonEmptyString(
              "paymentPayload.payload.settlement.requestIdHash",
              settlement?.requestIdHash
            );
            if (!isBytes32Hex(value)) {
              throw new Error("paymentPayload.payload.settlement.requestIdHash must be bytes32 hex.");
            }
            return value;
          })(),
          paymentIdHash: (() => {
            const value = assertNonEmptyString(
              "paymentPayload.payload.settlement.paymentIdHash",
              settlement?.paymentIdHash
            );
            if (!isBytes32Hex(value)) {
              throw new Error("paymentPayload.payload.settlement.paymentIdHash must be bytes32 hex.");
            }
            return value;
          })(),
          resultCommitment: (() => {
            const value = assertNonEmptyString(
              "paymentPayload.payload.settlement.resultCommitment",
              settlement?.resultCommitment
            );
            if (!isBytes32Hex(value)) {
              throw new Error("paymentPayload.payload.settlement.resultCommitment must be bytes32 hex.");
            }
            return value;
          })(),
          reserveExpiryUnix: BigInt(
            assertNonEmptyString(
              "paymentPayload.payload.settlement.reserveExpiryUnix",
              settlement?.reserveExpiryUnix ??
                (typeof reserveReleaseConfig?.expirySeconds === "number"
                  ? String(Math.floor(Date.now() / 1000) + reserveReleaseConfig.expirySeconds)
                  : "")
            )
          ),
          reserveMethod:
            settlement?.reserveMethod ??
            reserveReleaseConfig?.reserveMethod ??
            "reserveExactWithAuthorization",
          releaseMethod:
            settlement?.releaseMethod ??
            reserveReleaseConfig?.releaseMethod ??
            "releaseReservedPayment",
          refundMethod:
            settlement?.refundMethod ??
            reserveReleaseConfig?.refundMethod ??
            "refundExpiredPayment",
          ...(hasFeeSplit
            ? (() => {
                const feeBps = Number(
                  settlement?.feeBps ?? feeSplitConfig?.feeBps ?? 0
                );
                const grossAmount = BigInt(
                  assertNonEmptyString(
                    "paymentPayload.payload.settlement.grossAmount",
                    settlement?.grossAmount ?? feeSplitConfig?.grossAmount ?? accepted.amount
                  )
                );
                const sellerAmount = BigInt(
                  assertNonEmptyString(
                    "paymentPayload.payload.settlement.sellerAmount",
                    settlement?.sellerAmount ?? feeSplitConfig?.sellerAmount ?? accepted.amount
                  )
                );
                const protocolFeeAmount = BigInt(
                  assertNonEmptyString(
                    "paymentPayload.payload.settlement.protocolFeeAmount",
                    settlement?.protocolFeeAmount ?? feeSplitConfig?.protocolFeeAmount ?? "0"
                  )
                );
                const sellerPayTo = assertNonEmptyString(
                  "paymentPayload.payload.settlement.sellerPayTo",
                  settlement?.sellerPayTo ?? feeSplitConfig?.sellerPayTo ?? payTo
                );
                const protocolFeePayTo =
                  typeof (settlement?.protocolFeePayTo ?? feeSplitConfig?.protocolFeePayTo) === "string"
                    ? settlement?.protocolFeePayTo ?? feeSplitConfig?.protocolFeePayTo
                    : "";

                if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
                  throw new Error("paymentPayload.payload.settlement.feeBps must be an integer between 0 and 10000.");
                }
                if (grossAmount !== acceptedAmount) {
                  throw new Error("paymentPayload.payload.settlement.grossAmount must match paymentPayload.accepted.amount.");
                }
                if (sellerAmount + protocolFeeAmount !== grossAmount) {
                  throw new Error("paymentPayload.payload.settlement.grossAmount must equal sellerAmount + protocolFeeAmount.");
                }
                if (sellerPayTo.toLowerCase() !== payTo.toLowerCase()) {
                  throw new Error("paymentPayload.payload.settlement.sellerPayTo must match paymentPayload.accepted.payTo.");
                }
                if (protocolFeeAmount > 0n && protocolFeePayTo.length === 0) {
                  throw new Error("paymentPayload.payload.settlement.protocolFeePayTo is required when protocolFeeAmount > 0.");
                }

                return {
                  feeSplit: {
                    feeBps,
                    grossAmount,
                    sellerAmount,
                    protocolFeeAmount,
                    sellerPayTo,
                    protocolFeePayTo,
                    feeSettlementMode:
                      settlement?.feeSettlementMode ??
                      feeSplitConfig?.feeSettlementMode ??
                      "split-release-v1"
                  }
                };
              })()
            : {})
        }
      : null;
  const authorizationTarget = reserveRelease?.contractAddress ?? payTo;

  if (to.toLowerCase() !== authorizationTarget.toLowerCase()) {
    throw new Error(
      reserveRelease
        ? "Hosted reserve-release authorization.to must match the configured escrow contract."
        : "Hosted payment authorization.to must match paymentPayload.accepted.payTo."
    );
  }

  if (value !== acceptedAmount) {
    throw new Error("Hosted payment authorization.value must match paymentPayload.accepted.amount.");
  }

  return {
    request,
    hostedPaymentPayload,
    accepted,
    signature,
    networkId,
    chainId,
    tokenAddress,
    payTo,
    payer: from,
    authorization: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce
    },
    typedData: {
      domain: {
        name: domainName,
        version: domainVersion,
        chainId,
        verifyingContract: tokenAddress
      },
      primaryType: "TransferWithAuthorization",
      types: transferWithAuthorizationTypes(),
      message: {
        from,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce
      }
    },
    settlementModel,
    reserveRelease
  };
}

function makeClients(config) {
  const networkId = assertNonEmptyString("networkId", config?.networkId);
  const rpcUrls = normalizeRpcUrls(config);
  const rpcUrl = rpcUrls[0];
  const relayerPrivateKey = normalizePrivateKey(
    assertNonEmptyString("relayerPrivateKey", config?.relayerPrivateKey)
  );
  const chain = getChain(networkId);
  const account = privateKeyToAccount(relayerPrivateKey);
  const transport =
    rpcUrls.length === 1
      ? http(rpcUrl)
      : fallback(rpcUrls.map((url) => http(url)));
  const publicClient =
    config?.publicClient ??
    createPublicClient({
      ...(chain ? { chain } : {}),
      transport
    });
  const walletClient =
    config?.walletClient ??
    createWalletClient({
      account,
      ...(chain ? { chain } : {}),
      transport
    });

  return {
    networkId,
    chain,
    rpcUrl,
    rpcUrls,
    account,
    publicClient,
    walletClient
  };
}

async function readAuthorizationState(clients, payment) {
  return await clients.publicClient.readContract({
    address: payment.tokenAddress,
    abi: USDC_EIP3009_ABI,
    functionName: "authorizationState",
    args: [payment.authorization.from, payment.authorization.nonce]
  });
}

async function readBalance(clients, payment) {
  return await clients.publicClient.readContract({
    address: payment.tokenAddress,
    abi: USDC_EIP3009_ABI,
    functionName: "balanceOf",
    args: [payment.authorization.from]
  });
}

function verificationSummary(payment, clients, input) {
  return {
    isValid: input.isValid,
    ok: input.isValid,
    network: payment.networkId,
    payer: payment.payer,
    payTo: payment.payTo,
    asset: payment.accepted.asset,
    amount: payment.accepted.amount,
    relayer: clients.account.address,
    authorizationUsed: input.authorizationUsed,
    balance: input.balance.toString(),
    ...(payment.reserveRelease?.feeSplit
      ? {
          feeSplit: {
            feeBps: payment.reserveRelease.feeSplit.feeBps,
            grossAmount: payment.reserveRelease.feeSplit.grossAmount.toString(),
            sellerAmount: payment.reserveRelease.feeSplit.sellerAmount.toString(),
            protocolFeeAmount: payment.reserveRelease.feeSplit.protocolFeeAmount.toString(),
            sellerPayTo: payment.reserveRelease.feeSplit.sellerPayTo,
            protocolFeePayTo: payment.reserveRelease.feeSplit.protocolFeePayTo
          }
        }
      : {}),
    ...(input.invalidReason ? { invalidReason: input.invalidReason, error: input.invalidReason } : {})
  };
}

async function verifyHostedPayment(clients, input) {
  const payment = normalizeHostedExactPayment(input);
  const signatureValid = await verifyTypedData({
    address: payment.authorization.from,
    domain: payment.typedData.domain,
    types: payment.typedData.types,
    primaryType: payment.typedData.primaryType,
    message: payment.typedData.message,
    signature: payment.signature
  });

  if (!signatureValid) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "EIP-3009 signature verification failed.",
      authorizationUsed: false,
      balance: 0n
    });
  }

  const [authorizationUsed, balance] = await Promise.all([
    readAuthorizationState(clients, payment),
    readBalance(clients, payment)
  ]);

  if (authorizationUsed) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "EIP-3009 authorization nonce was already used.",
      authorizationUsed,
      balance
    });
  }

  if (balance < payment.authorization.value) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "Payer does not hold enough USDC for the requested x402 payment.",
      authorizationUsed,
      balance
    });
  }

  return verificationSummary(payment, clients, {
    isValid: true,
    authorizationUsed,
    balance
  });
}

async function settleHostedPayment(clients, input) {
  const payment = normalizeHostedExactPayment(input);
  const verification = await verifyHostedPayment(clients, input);

  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? "Hosted EVM payment verification failed.",
      verification
    };
  }

  const { v, r, s } = parseSignature(payment.signature);

  try {
    const transactionHash = payment.reserveRelease
      ? await clients.walletClient.writeContract({
          account: clients.account,
          chain: clients.chain,
          address: payment.reserveRelease.contractAddress,
          abi: X402_RESERVE_RELEASE_ESCROW_ABI,
          functionName: payment.reserveRelease.reserveMethod,
          args: payment.reserveRelease.feeSplit
            ? [
                payment.reserveRelease.requestIdHash,
                payment.reserveRelease.paymentIdHash,
                payment.authorization.from,
                payment.reserveRelease.feeSplit.sellerPayTo,
                payment.reserveRelease.feeSplit.protocolFeePayTo,
                payment.tokenAddress,
                payment.reserveRelease.feeSplit.grossAmount,
                payment.reserveRelease.feeSplit.sellerAmount,
                payment.reserveRelease.feeSplit.protocolFeeAmount,
                payment.reserveRelease.feeSplit.feeBps,
                payment.authorization.validAfter,
                payment.authorization.validBefore,
                payment.authorization.nonce,
                payment.reserveRelease.resultCommitment,
                payment.reserveRelease.reserveExpiryUnix,
                v,
                r,
                s
              ]
            : [
                payment.reserveRelease.requestIdHash,
                payment.reserveRelease.paymentIdHash,
                payment.authorization.from,
                payment.payTo,
                payment.tokenAddress,
                payment.authorization.value,
                payment.authorization.validAfter,
                payment.authorization.validBefore,
                payment.authorization.nonce,
                payment.reserveRelease.resultCommitment,
                payment.reserveRelease.reserveExpiryUnix,
                v,
                r,
                s
              ]
        })
      : await clients.walletClient.writeContract({
          account: clients.account,
          chain: clients.chain,
          address: payment.tokenAddress,
          abi: USDC_EIP3009_ABI,
          functionName: "transferWithAuthorization",
          args: [
            payment.authorization.from,
            payment.authorization.to,
            payment.authorization.value,
            payment.authorization.validAfter,
            payment.authorization.validBefore,
            payment.authorization.nonce,
            v,
            r,
            s
          ]
        });
    const receipt =
      typeof clients.publicClient.waitForTransactionReceipt === "function"
        ? await clients.publicClient.waitForTransactionReceipt({ hash: transactionHash })
        : null;

      return {
        success: true,
        network: payment.networkId,
        payer: payment.payer,
        payTo: payment.payTo,
        relayer: clients.account.address,
        settlementModel: payment.settlementModel ?? "x402-exact-evm-v1",
        transaction: transactionHash,
        txHash: transactionHash,
        transactionHash,
        ...(payment.reserveRelease
          ? {
              reserveRelease: {
                contractAddress: payment.reserveRelease.contractAddress,
                requestIdHash: payment.reserveRelease.requestIdHash,
                paymentIdHash: payment.reserveRelease.paymentIdHash,
                resultCommitment: payment.reserveRelease.resultCommitment
              }
            }
          : {}),
        ...(payment.reserveRelease?.feeSplit
          ? {
              feeSplit: {
                feeBps: payment.reserveRelease.feeSplit.feeBps,
                grossAmount: payment.reserveRelease.feeSplit.grossAmount.toString(),
                sellerAmount: payment.reserveRelease.feeSplit.sellerAmount.toString(),
                protocolFeeAmount: payment.reserveRelease.feeSplit.protocolFeeAmount.toString(),
                sellerPayTo: payment.reserveRelease.feeSplit.sellerPayTo,
                protocolFeePayTo: payment.reserveRelease.feeSplit.protocolFeePayTo
              }
            }
          : {}),
        ...(receipt
          ? {
            receipt: {
              status: receipt.status,
              blockHash: receipt.blockHash,
              blockNumber:
                typeof receipt.blockNumber === "bigint"
                  ? receipt.blockNumber.toString()
                  : receipt.blockNumber
            }
          }
        : {})
    };
  } catch (error) {
    const authorizationUsed = await readAuthorizationState(clients, payment).catch(() => false);
    const decodedError = decodeKnownExecutionError(error);
    const errorReason =
      decodedError?.reason ??
      (authorizationUsed
        ? "EIP-3009 authorization nonce was already used."
        : error instanceof Error
          ? error.message
          : String(error));

    return {
      success: false,
      errorReason,
      ...(decodedError
        ? {
            errorCode: decodedError.errorCode,
            errorName: decodedError.errorName,
            errorArgs: decodedError.errorArgs,
            revertData: decodedError.revertData
          }
        : authorizationUsed
          ? { errorCode: "authorization_used" }
          : { errorCode: "settlement_failed" }),
      verification: {
        ...verification,
        authorizationUsed
      }
    };
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        if (chunks.length === 0) {
          resolve({});
          return;
        }

        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export class SelfHostedEvmFacilitator {
  constructor(input = {}) {
    const networks = Array.isArray(input.networks) ? input.networks : [];

    if (networks.length === 0) {
      throw new Error("SelfHostedEvmFacilitator requires at least one configured EVM network.");
    }

    this.networks = new Map(
      networks.map((network) => [network.networkId, makeClients(network)])
    );
  }

  getClients(networkId) {
    const clients = this.networks.get(networkId);

    if (!clients) {
      throw new Error(`Self-hosted EVM facilitator is not configured for ${networkId}.`);
    }

    return clients;
  }

  async supported() {
    return {
      ok: true,
      networks: [...this.networks.values()].map((entry) => ({
        networkId: entry.networkId,
        rpcUrl: entry.rpcUrl,
        rpcUrls: entry.rpcUrls,
        relayer: entry.account.address
      }))
    };
  }

  async verify(input) {
    const payment = normalizeHostedExactPayment(input);
    const clients = this.getClients(payment.networkId);
    return await verifyHostedPayment(clients, input);
  }

  async settle(input) {
    const payment = normalizeHostedExactPayment(input);
    const clients = this.getClients(payment.networkId);
    return await settleHostedPayment(clients, input);
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

export function createSelfHostedEvmFacilitatorHttpServer(input = {}) {
  const facilitator =
    input.facilitator instanceof SelfHostedEvmFacilitator
      ? input.facilitator
      : new SelfHostedEvmFacilitator(input);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/supported") {
        sendJson(response, 200, await facilitator.supported());
        return;
      }

      if (request.method === "POST" && url.pathname === "/verify") {
        const body = await readJsonBody(request);
        sendJson(response, 200, await facilitator.verify(body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/settle") {
        const body = await readJsonBody(request);
        sendJson(response, 200, await facilitator.settle(body));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "unexpected_error"
      });
    }
  });
}
