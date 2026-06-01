import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

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

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class RelayerSettlementLockError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RelayerSettlementLockError";
    this.errorCode = options.errorCode ?? "relayer_lock_unavailable";
    this.recoverable = options.recoverable ?? true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function isRelayerSettlementLockError(error) {
  return error instanceof RelayerSettlementLockError || error?.name === "RelayerSettlementLockError";
}

function relayerSettlementLockInfo(lock) {
  if (!lock) {
    return { type: "in_process" };
  }

  if (typeof lock.info === "function") {
    return lock.info();
  }

  if (isRecord(lock.info)) {
    return lock.info;
  }

  return { type: "external" };
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

function redactRpcUrl(value) {
  try {
    const url = new URL(value);
    const redactedPath = url.pathname
      .split("/")
      .map((segment) =>
        /^[A-Za-z0-9_-]{16,}$/.test(segment) || segment.toLowerCase().includes("key")
          ? "redacted"
          : segment
      )
      .join("/");

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = redactedPath;
    return url.toString();
  } catch {
    return "<redacted-rpc-url>";
  }
}

function appendHttpLockPath(baseUrl, path) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return url.toString();
}

function parseRetryAfterMs(response, body, fallback) {
  if (body && Number.isFinite(Number(body.retryAfterMs))) {
    return Math.max(0, Number(body.retryAfterMs));
  }

  const retryAfter = response.headers?.get?.("retry-after");
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallback;
}

function defaultRelayerLockRenewIntervalMs(ttlMs) {
  return Math.max(1_000, Math.min(60_000, Math.floor(ttlMs / 3)));
}

async function postRelayerLockJson(config, path, body) {
  if (typeof fetch !== "function") {
    throw new RelayerSettlementLockError(
      "HTTP relayer settlement locks require a Node.js runtime with global fetch.",
      { recoverable: false }
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(appendHttpLockPath(config.url, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const json = text
      ? (() => {
          try {
            return JSON.parse(text);
          } catch {
            return { raw: text };
          }
        })()
      : {};

    return { response, json };
  } catch (error) {
    if (isRelayerSettlementLockError(error)) {
      throw error;
    }

    throw new RelayerSettlementLockError("Relayer settlement lock service request failed.", {
      cause: error,
      retryAfterMs: config.retryDelayMs
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function renewHttpRelayerSettlementLock(config, key, lockId, context) {
  const { response, json } = await postRelayerLockJson(config, "renew", {
    key,
    lockId,
    owner: config.owner,
    ttlMs: config.ttlMs,
    context
  });
  const returnedLockId = json?.lockId ?? json?.id;
  const lockIdMatches = returnedLockId !== undefined && String(returnedLockId) === String(lockId);
  const renewed =
    response.ok &&
    (
      json?.renewed === true ||
      json?.ok === true ||
      json?.acquired === true ||
      lockIdMatches
    );

  if (renewed) {
    return;
  }

  if (response.status === 401 || response.status === 403) {
    throw new RelayerSettlementLockError("Relayer settlement lock service rejected lock renewal.", {
      errorCode: "relayer_lock_rejected",
      recoverable: false
    });
  }

  throw new RelayerSettlementLockError("Relayer settlement lock renewal failed.", {
    retryAfterMs: parseRetryAfterMs(response, json, config.retryDelayMs)
  });
}

function reportRelayerLockRenewalFailure(config, error, context) {
  if (typeof config.onRenewalFailure === "function") {
    config.onRenewalFailure(error, context);
    return;
  }

  console.error(
    "[zeko-x402] relayer settlement lock renewal failed",
    {
      key: context.key,
      lockId: context.lockId,
      renewalFailures: context.renewalFailures,
      error: error instanceof Error ? error.message : String(error)
    }
  );
}

function startHttpRelayerSettlementLockRenewal(config, key, lockId, context) {
  if (config.renewIntervalMs <= 0) {
    return async () => {};
  }

  let stopped = false;
  let renewal = Promise.resolve();
  let renewalFailures = 0;
  const timer = setInterval(() => {
    renewal = renewal
      .catch((error) => {
        renewalFailures += 1;
        reportRelayerLockRenewalFailure(config, error, {
          key,
          lockId,
          context,
          renewalFailures
        });
      })
      .then(async () => {
        if (!stopped) {
          await renewHttpRelayerSettlementLock(config, key, lockId, context);
        }
      });
  }, config.renewIntervalMs);
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await renewal.catch((error) => {
      renewalFailures += 1;
      reportRelayerLockRenewalFailure(config, error, {
        key,
        lockId,
        context,
        renewalFailures
      });
    });
  };
}

export function createHttpRelayerSettlementLock(input = {}) {
  const url = assertNonEmptyString("url", input.url);
  const ttlMs = parsePositiveInteger(input.ttlMs, 600_000);
  const config = {
    url,
    bearerToken: typeof input.bearerToken === "string" && input.bearerToken.length > 0
      ? input.bearerToken
      : "",
    owner: input.owner ?? `${hostname()}:${process.pid}:${randomUUID()}`,
    ttlMs,
    renewIntervalMs: parseNonNegativeInteger(
      input.renewIntervalMs,
      defaultRelayerLockRenewIntervalMs(ttlMs)
    ),
    acquireTimeoutMs: parsePositiveInteger(input.acquireTimeoutMs, 15_000),
    retryDelayMs: parsePositiveInteger(input.retryDelayMs, 250),
    requestTimeoutMs: parsePositiveInteger(input.requestTimeoutMs, 5_000),
    onRenewalFailure: typeof input.onRenewalFailure === "function" ? input.onRenewalFailure : null
  };

  return {
    info: {
      type: "http",
      url: redactRpcUrl(url),
      ttlMs: config.ttlMs,
      renewIntervalMs: config.renewIntervalMs,
      renewal: config.renewIntervalMs > 0 ? "enabled" : "disabled",
      acquireTimeoutMs: config.acquireTimeoutMs,
      retryDelayMs: config.retryDelayMs,
      requestTimeoutMs: config.requestTimeoutMs
    },
    async acquire(key, context = {}) {
      const deadline = Date.now() + config.acquireTimeoutMs;
      let lastError;

      while (Date.now() <= deadline) {
        const body = {
          key,
          owner: config.owner,
          ttlMs: config.ttlMs,
          context
        };
        const { response, json } = await postRelayerLockJson(config, "acquire", body);
        const retryAfterMs = parseRetryAfterMs(response, json, config.retryDelayMs);
        const acquired =
          response.ok &&
          (
            json?.acquired === true ||
            json?.ok === true ||
            typeof json?.lockId === "string" ||
            typeof json?.id === "string"
          );

        if (acquired) {
          const lockId = json.lockId ?? json.id ?? key;
          const stopRenewal = startHttpRelayerSettlementLockRenewal(config, key, lockId, context);

          return async () => {
            try {
              await stopRenewal();
            } finally {
              await postRelayerLockJson(config, "release", {
                key,
                lockId,
                owner: config.owner,
                context
              });
            }
          };
        }

        if (response.status === 401 || response.status === 403) {
          throw new RelayerSettlementLockError("Relayer settlement lock service rejected the request.", {
            errorCode: "relayer_lock_rejected",
            recoverable: false
          });
        }

        if (response.status >= 400 && response.status < 500 && ![409, 423, 425, 429].includes(response.status)) {
          throw new RelayerSettlementLockError("Relayer settlement lock service rejected the lock payload.", {
            errorCode: "relayer_lock_rejected",
            recoverable: false
          });
        }

        lastError = new RelayerSettlementLockError("Relayer settlement lock is currently held.", {
          retryAfterMs
        });
        await wait(Math.min(retryAfterMs, Math.max(0, deadline - Date.now())));
      }

      throw new RelayerSettlementLockError("Timed out acquiring relayer settlement lock.", {
        cause: lastError,
        retryAfterMs: config.retryDelayMs
      });
    }
  };
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transientRpcMessage(error) {
  if (error instanceof Error) {
    return [
      error.message,
      error.cause instanceof Error ? error.cause.message : "",
      typeof error.details === "string" ? error.details : "",
      typeof error.shortMessage === "string" ? error.shortMessage : ""
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
  }

  return String(error ?? "").toLowerCase();
}

function isTransientRpcError(error) {
  const message = transientRpcMessage(error);
  return (
    message.includes("over rate limit") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("temporarily unavailable") ||
    message.includes("bad gateway") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  );
}

function isRelayerNonceConflictError(error) {
  const message = transientRpcMessage(error);
  return (
    message.includes("nonce too low") ||
    message.includes("tx nonce") ||
    message.includes("replacement transaction underpriced") ||
    message.includes("transaction underpriced") ||
    message.includes("already known") ||
    message.includes("known transaction") ||
    message.includes("fee too low") ||
    message.includes("max fee per gas less than block base fee")
  );
}

async function retryTransientRpc(clients, label, fn) {
  let lastError;

  for (let attempt = 0; attempt <= clients.rpcRetryCount; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTransientRpcError(error) || attempt >= clients.rpcRetryCount) {
        throw error;
      }

      const delayMs = clients.rpcRetryDelayMs * 2 ** attempt;
      await wait(delayMs);
    }
  }

  throw lastError ?? new Error(`${label} failed.`);
}

const relayerSettlementQueues = new Map();

function relayerSettlementQueueKey(clients) {
  return `${clients.networkId}:${clients.account.address.toLowerCase()}`;
}

function relayerSettlementLockContext(clients, key) {
  return {
    key,
    networkId: clients.networkId,
    relayer: clients.account.address
  };
}

async function releaseRelayerSettlementLock(release) {
  try {
    if (typeof release === "function") {
      await release();
      return;
    }

    if (release && typeof release.release === "function") {
      await release.release();
    }
  } catch {
    // The lock has a TTL; do not turn a completed settlement into a failed one.
  }
}

async function withRelayerSettlementLock(clients, key, fn) {
  const lock = clients.relayerSettlementLock;

  if (!lock) {
    return await fn();
  }

  const context = relayerSettlementLockContext(clients, key);

  if (typeof lock.acquire === "function") {
    let release;

    try {
      release = await lock.acquire(key, context);
    } catch (error) {
      if (isRelayerSettlementLockError(error)) {
        throw error;
      }

      throw new RelayerSettlementLockError("Relayer settlement lock acquire failed.", {
        cause: error
      });
    }

    try {
      return await fn();
    } finally {
      await releaseRelayerSettlementLock(release);
    }
  }

  if (typeof lock.withLock === "function") {
    return await lock.withLock(key, context, fn);
  }

  throw new RelayerSettlementLockError("Relayer settlement lock must expose acquire() or withLock().", {
    recoverable: false
  });
}

async function withRelayerSettlementQueue(clients, fn) {
  const key = relayerSettlementQueueKey(clients);
  const previous = relayerSettlementQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => withRelayerSettlementLock(clients, key, fn));
  const stored = current.catch(() => {});
  relayerSettlementQueues.set(key, stored);

  try {
    return await current;
  } finally {
    if (relayerSettlementQueues.get(key) === stored) {
      relayerSettlementQueues.delete(key);
    }
  }
}

function createRelayerTransactionManager(clients) {
  let nextNonce = null;

  async function nextNonceParams() {
    if (typeof clients.publicClient.getTransactionCount !== "function") {
      return {};
    }

    if (nextNonce === null) {
      const pendingNonce = await retryTransientRpc(clients, "getTransactionCount", async () => {
        return await clients.publicClient.getTransactionCount({
          address: clients.account.address,
          blockTag: "pending"
        });
      });
      nextNonce = Number(pendingNonce);
    }

    return Number.isFinite(nextNonce) ? { nonce: nextNonce } : {};
  }

  function markNonceConsumed(params) {
    if (Number.isFinite(params?.nonce)) {
      nextNonce = params.nonce + 1;
    }
  }

  function resetNonce() {
    nextNonce = null;
  }

  return {
    async writeContract(params) {
      const nonceParams = await nextNonceParams();

      try {
        const hash = await clients.walletClient.writeContract({
          ...params,
          ...nonceParams
        });
        markNonceConsumed(nonceParams);
        return hash;
      } catch (error) {
        resetNonce();
        throw error;
      }
    }
  };
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

function assertOptionalStringMatch(label, provided, expected) {
  if (typeof provided === "string" && provided.length > 0 && provided !== expected) {
    throw new Error(`${label} must match the advertised reserve-release configuration.`);
  }

  return expected;
}

function assertOptionalAddressMatch(label, provided, expected) {
  if (typeof provided === "string" && provided.length > 0 && provided.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} must match the advertised reserve-release configuration.`);
  }

  return expected;
}

function assertOptionalBigIntMatch(label, provided, expected) {
  if (provided !== undefined && provided !== null) {
    const actual = BigInt(assertNonEmptyString(label, provided));
    if (actual !== expected) {
      throw new Error(`${label} must match the advertised reserve-release fee split.`);
    }
  }

  return expected;
}

function parseHostedAuthorizationLeg(label, authorization, signature) {
  if (!isRecord(authorization)) {
    throw new Error(`${label}.authorization is required.`);
  }

  if (typeof signature !== "string" || signature.length === 0) {
    throw new Error(`${label}.signature is required.`);
  }

  return {
    signature,
    authorization: {
      from: assertNonEmptyString(`${label}.authorization.from`, authorization.from),
      to: assertNonEmptyString(`${label}.authorization.to`, authorization.to),
      value: BigInt(assertNonEmptyString(`${label}.authorization.value`, authorization.value)),
      validAfter: BigInt(assertNonEmptyString(`${label}.authorization.validAfter`, authorization.validAfter)),
      validBefore: BigInt(assertNonEmptyString(`${label}.authorization.validBefore`, authorization.validBefore)),
      nonce: assertNonEmptyString(`${label}.authorization.nonce`, authorization.nonce)
    }
  };
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
  const primaryLeg = parseHostedAuthorizationLeg(
    "paymentPayload.payload",
    payload.authorization,
    payload.signature
  );
  const networkId = assertNonEmptyString("paymentPayload.accepted.network", accepted?.network);
  const chainId = parseChainId(networkId);
  const tokenAddress = assertNonEmptyString("paymentPayload.accepted.asset", accepted?.asset);
  const payTo = assertNonEmptyString("paymentPayload.accepted.payTo", accepted?.payTo);
  const domainName = assertNonEmptyString(
    "paymentPayload.accepted.extra.name",
    accepted?.extra?.name ?? "USD Coin"
  );
  const domainVersion = accepted?.extra?.version ?? "2";

  const from = primaryLeg.authorization.from;
  const to = primaryLeg.authorization.to;
  const value = primaryLeg.authorization.value;
  const validAfter = primaryLeg.authorization.validAfter;
  const validBefore = primaryLeg.authorization.validBefore;
  const nonce = primaryLeg.authorization.nonce;
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
          contractAddress:
            reserveReleaseConfig
              ? assertOptionalAddressMatch(
                  "paymentPayload.payload.settlement.contractAddress",
                  settlement?.contractAddress,
                  assertNonEmptyString(
                    "paymentPayload.accepted.extra.reserveRelease.escrowContract",
                    reserveReleaseConfig.escrowContract
                  )
                )
              : assertNonEmptyString(
                  "paymentPayload.payload.settlement.contractAddress",
                  settlement?.contractAddress
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
            reserveReleaseConfig
              ? assertOptionalStringMatch(
                  "paymentPayload.payload.settlement.reserveMethod",
                  settlement?.reserveMethod,
                  reserveReleaseConfig?.reserveMethod ?? "reserveExactWithAuthorization"
                )
              : settlement?.reserveMethod ?? "reserveExactWithAuthorization",
          releaseMethod:
            reserveReleaseConfig
              ? assertOptionalStringMatch(
                  "paymentPayload.payload.settlement.releaseMethod",
                  settlement?.releaseMethod,
                  reserveReleaseConfig?.releaseMethod ?? "releaseReservedPayment"
                )
              : settlement?.releaseMethod ?? "releaseReservedPayment",
          refundMethod:
            reserveReleaseConfig
              ? assertOptionalStringMatch(
                  "paymentPayload.payload.settlement.refundMethod",
                  settlement?.refundMethod,
                  reserveReleaseConfig?.refundMethod ?? "refundExpiredPayment"
                )
              : settlement?.refundMethod ?? "refundExpiredPayment",
          ...(hasFeeSplit
            ? (() => {
                if (!feeSplitConfig) {
                  throw new Error("Hosted reserve-release fee rails require paymentPayload.accepted.extra.feeSplit.");
                }

                const feeBps = Number(feeSplitConfig?.feeBps ?? 0);
                const grossAmount = acceptedAmount;
                const protocolFeeAmount = (grossAmount * BigInt(feeBps)) / 10_000n;
                const sellerAmount = grossAmount - protocolFeeAmount;
                const sellerPayTo = assertNonEmptyString(
                  "paymentPayload.accepted.extra.feeSplit.sellerPayTo",
                  feeSplitConfig?.sellerPayTo ?? payTo
                );
                const protocolFeePayTo = assertNonEmptyString(
                  "paymentPayload.accepted.extra.feeSplit.protocolFeePayTo",
                  feeSplitConfig?.protocolFeePayTo
                );
                const feeSettlementMode = feeSplitConfig?.feeSettlementMode ?? "split-release-v1";

                if (!Number.isInteger(feeBps) || feeBps <= 0 || feeBps >= 10_000) {
                  throw new Error("paymentPayload.accepted.extra.feeSplit.feeBps must be an integer between 1 and 9999.");
                }
                if (sellerPayTo.toLowerCase() !== payTo.toLowerCase()) {
                  throw new Error("paymentPayload.accepted.extra.feeSplit.sellerPayTo must match paymentPayload.accepted.payTo.");
                }

                assertOptionalStringMatch("paymentPayload.payload.settlement.mode", settlement?.mode, feeSettlementMode === "fee-on-reserve-v1" ? "reserve-release-v4" : "reserve-release-v3");
                if (settlement?.feeBps !== undefined && Number(settlement.feeBps) !== feeBps) {
                  throw new Error("paymentPayload.payload.settlement.feeBps must match the advertised reserve-release fee split.");
                }
                assertOptionalBigIntMatch("paymentPayload.payload.settlement.grossAmount", settlement?.grossAmount, grossAmount);
                assertOptionalBigIntMatch("paymentPayload.payload.settlement.sellerAmount", settlement?.sellerAmount, sellerAmount);
                assertOptionalBigIntMatch(
                  "paymentPayload.payload.settlement.protocolFeeAmount",
                  settlement?.protocolFeeAmount,
                  protocolFeeAmount
                );
                assertOptionalAddressMatch("paymentPayload.payload.settlement.sellerPayTo", settlement?.sellerPayTo, sellerPayTo);
                assertOptionalAddressMatch(
                  "paymentPayload.payload.settlement.protocolFeePayTo",
                  settlement?.protocolFeePayTo,
                  protocolFeePayTo
                );
                assertOptionalStringMatch(
                  "paymentPayload.payload.settlement.feeSettlementMode",
                  settlement?.feeSettlementMode,
                  feeSettlementMode
                );

                return {
                  feeSplit: {
                    feeBps,
                    grossAmount,
                    sellerAmount,
                    protocolFeeAmount,
                    sellerPayTo,
                    protocolFeePayTo,
                    feeSettlementMode,
                    ...(typeof feeSplitConfig?.feePolicyDigest === "string" && feeSplitConfig.feePolicyDigest.length > 0
                      ? { feePolicyDigest: feeSplitConfig.feePolicyDigest }
                      : {})
                  }
                };
              })()
            : {})
        }
      : null;
  const exactFeeSplit =
    !reserveRelease && feeSplitConfig
      ? (() => {
          const feeBps = Number.isInteger(feeSplitConfig.feeBps)
            ? Number(feeSplitConfig.feeBps)
            : 0;
          const grossAmount = BigInt(feeSplitConfig.grossAmount ?? acceptedAmount.toString());
          const sellerAmount = BigInt(assertNonEmptyString(
            "paymentPayload.accepted.extra.feeSplit.sellerAmount",
            feeSplitConfig.sellerAmount
          ));
          const protocolFeeAmount = BigInt(assertNonEmptyString(
            "paymentPayload.accepted.extra.feeSplit.protocolFeeAmount",
            feeSplitConfig.protocolFeeAmount
          ));
          const sellerPayTo = assertNonEmptyString(
            "paymentPayload.accepted.extra.feeSplit.sellerPayTo",
            feeSplitConfig.sellerPayTo ?? payTo
          );
          const protocolFeePayTo = assertNonEmptyString(
            "paymentPayload.accepted.extra.feeSplit.protocolFeePayTo",
            feeSplitConfig.protocolFeePayTo
          );

          if (grossAmount !== acceptedAmount) {
            throw new Error("paymentPayload.accepted.extra.feeSplit.grossAmount must match paymentPayload.accepted.amount.");
          }

          if (sellerAmount <= 0n || protocolFeeAmount <= 0n) {
            throw new Error("Hosted exact fee split requires positive seller and protocol fee amounts.");
          }

          if (sellerAmount + protocolFeeAmount !== grossAmount) {
            throw new Error("Hosted exact fee split amounts must sum to paymentPayload.accepted.amount.");
          }

          if (sellerPayTo.toLowerCase() !== payTo.toLowerCase()) {
            throw new Error("paymentPayload.accepted.extra.feeSplit.sellerPayTo must match paymentPayload.accepted.payTo.");
          }

          return {
            feeBps,
            grossAmount,
            sellerAmount,
            protocolFeeAmount,
            sellerPayTo,
            protocolFeePayTo,
            feeSettlementMode: feeSplitConfig.feeSettlementMode ?? "exact-eip3009-split-v1",
            ...(typeof feeSplitConfig.feePolicyDigest === "string" && feeSplitConfig.feePolicyDigest.length > 0
              ? { feePolicyDigest: feeSplitConfig.feePolicyDigest }
              : {})
          };
        })()
      : null;
  const authorizationTarget = reserveRelease?.contractAddress ?? exactFeeSplit?.sellerPayTo ?? payTo;
  const authorizationValue = exactFeeSplit?.sellerAmount ?? acceptedAmount;

  if (to.toLowerCase() !== authorizationTarget.toLowerCase()) {
    throw new Error(
      reserveRelease
        ? "Hosted reserve-release authorization.to must match the configured escrow contract."
        : exactFeeSplit
          ? "Hosted exact fee-split seller authorization.to must match paymentPayload.accepted.payTo."
        : "Hosted payment authorization.to must match paymentPayload.accepted.payTo."
    );
  }

  if (value !== authorizationValue) {
    throw new Error(
      exactFeeSplit
        ? "Hosted exact fee-split seller authorization.value must match the advertised seller amount."
        : "Hosted payment authorization.value must match paymentPayload.accepted.amount."
    );
  }

  const hostedFeeLeg = isRecord(payload?.feeAuthorization) ? payload.feeAuthorization : null;
  const feeLeg =
    exactFeeSplit
      ? parseHostedAuthorizationLeg(
          "paymentPayload.payload.feeAuthorization",
          hostedFeeLeg?.authorization,
          hostedFeeLeg?.signature
        )
      : null;

  if (exactFeeSplit && feeLeg) {
    if (feeLeg.authorization.from.toLowerCase() !== from.toLowerCase()) {
      throw new Error("Hosted exact fee-split feeAuthorization.from must match the seller authorization payer.");
    }

    if (feeLeg.authorization.to.toLowerCase() !== exactFeeSplit.protocolFeePayTo.toLowerCase()) {
      throw new Error("Hosted exact fee-split feeAuthorization.to must match protocolFeePayTo.");
    }

    if (feeLeg.authorization.value !== exactFeeSplit.protocolFeeAmount) {
      throw new Error("Hosted exact fee-split feeAuthorization.value must match the advertised protocol fee amount.");
    }

    if (feeLeg.authorization.nonce.toLowerCase() === nonce.toLowerCase()) {
      throw new Error("Hosted exact fee-split seller and protocol fee authorizations must use different nonces.");
    }
  }

  return {
    request,
    hostedPaymentPayload,
    accepted,
    signature: primaryLeg.signature,
    ...(feeLeg ? { feeSignature: feeLeg.signature } : {}),
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
    ...(feeLeg
      ? {
          feeAuthorization: feeLeg.authorization,
          feeTypedData: {
            domain: {
              name: domainName,
              version: domainVersion,
              chainId,
              verifyingContract: tokenAddress
            },
            primaryType: "TransferWithAuthorization",
            types: transferWithAuthorizationTypes(),
            message: {
              from: feeLeg.authorization.from,
              to: feeLeg.authorization.to,
              value: feeLeg.authorization.value.toString(),
              validAfter: feeLeg.authorization.validAfter.toString(),
              validBefore: feeLeg.authorization.validBefore.toString(),
              nonce: feeLeg.authorization.nonce
            }
          }
        }
      : {}),
    settlementModel,
    reserveRelease,
    exactFeeSplit
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
  const rpcRetryCount = parseNonNegativeInteger(
    config?.rpcRetryCount ?? process.env.X402_EVM_RPC_RETRY_COUNT,
    2
  );
  const rpcRetryDelayMs = parsePositiveInteger(
    config?.rpcRetryDelayMs ?? process.env.X402_EVM_RPC_RETRY_DELAY_MS,
    250
  );
  const rpcTimeoutMs = parsePositiveInteger(
    config?.rpcTimeoutMs ?? process.env.X402_EVM_RPC_TIMEOUT_MS,
    10_000
  );
  const transport =
    rpcUrls.length === 1
      ? http(rpcUrl, { retryCount: rpcRetryCount, retryDelay: rpcRetryDelayMs, timeout: rpcTimeoutMs })
      : fallback(
          rpcUrls.map((url) =>
            http(url, { retryCount: rpcRetryCount, retryDelay: rpcRetryDelayMs, timeout: rpcTimeoutMs })
          ),
          { retryCount: rpcRetryCount, retryDelay: rpcRetryDelayMs }
        );
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

  const clients = {
    networkId,
    chain,
    rpcUrl,
    rpcUrls,
    rpcRetryCount,
    rpcRetryDelayMs,
    rpcTimeoutMs,
    account,
    relayerSettlementLock: config?.relayerSettlementLock ?? null,
    publicClient,
    walletClient
  };
  clients.transactionManager = config?.transactionManager ?? createRelayerTransactionManager(clients);
  return clients;
}

async function readAuthorizationState(clients, payment, authorization = payment.authorization) {
  return await retryTransientRpc(clients, "authorizationState", async () => {
    return await clients.publicClient.readContract({
      address: payment.tokenAddress,
      abi: USDC_EIP3009_ABI,
      functionName: "authorizationState",
      args: [authorization.from, authorization.nonce]
    });
  });
}

async function readBalance(clients, payment) {
  return await retryTransientRpc(clients, "balanceOf", async () => {
    return await clients.publicClient.readContract({
      address: payment.tokenAddress,
      abi: USDC_EIP3009_ABI,
      functionName: "balanceOf",
      args: [payment.authorization.from]
    });
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
    ...(input.feeAuthorizationUsed !== undefined ? { feeAuthorizationUsed: input.feeAuthorizationUsed } : {}),
    balance: input.balance.toString(),
    ...(input.settlementState ? { settlementState: input.settlementState } : {}),
    ...(input.recoverable !== undefined ? { recoverable: input.recoverable } : {}),
    ...(input.nextSettlementAction ? { nextSettlementAction: input.nextSettlementAction } : {}),
    ...(input.duplicate !== undefined ? { duplicate: input.duplicate } : {}),
    ...(payment.reserveRelease?.feeSplit || payment.exactFeeSplit
      ? {
          feeSplit: {
            feeBps: (payment.reserveRelease?.feeSplit ?? payment.exactFeeSplit).feeBps,
            grossAmount: (payment.reserveRelease?.feeSplit ?? payment.exactFeeSplit).grossAmount.toString(),
            sellerAmount: (payment.reserveRelease?.feeSplit ?? payment.exactFeeSplit).sellerAmount.toString(),
            protocolFeeAmount: (payment.reserveRelease?.feeSplit ?? payment.exactFeeSplit).protocolFeeAmount.toString(),
            sellerPayTo: (payment.reserveRelease?.feeSplit ?? payment.exactFeeSplit).sellerPayTo,
            protocolFeePayTo: (payment.reserveRelease?.feeSplit ?? payment.exactFeeSplit).protocolFeePayTo
          }
        }
      : {}),
    ...(input.invalidReason ? { invalidReason: input.invalidReason, error: input.invalidReason } : {})
  };
}

async function verifyHostedPayment(clients, input) {
  const payment = normalizeHostedExactPayment(input);
  const signatures = await verifyHostedPaymentSignatures(payment);

  if (!signatures.signatureValid) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "EIP-3009 signature verification failed.",
      authorizationUsed: false,
      balance: 0n
    });
  }

  if (!signatures.feeSignatureValid) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "EIP-3009 protocol fee signature verification failed.",
      authorizationUsed: false,
      balance: 0n
    });
  }

  const usage = await readHostedPaymentUsage(clients, payment);

  if (!payment.reserveRelease && (usage.authorizationUsed || usage.feeAuthorizationUsed)) {
    const outstandingAmount =
      (usage.authorizationUsed ? 0n : payment.authorization.value) +
      (payment.exactFeeSplit && !usage.feeAuthorizationUsed ? payment.feeAuthorization.value : 0n);
    const fullySettled = usage.authorizationUsed && (!payment.exactFeeSplit || usage.feeAuthorizationUsed);

    if (!fullySettled && usage.balance < outstandingAmount) {
      return verificationSummary(payment, clients, {
        isValid: false,
        invalidReason: "Payer does not hold enough USDC for the unsettled x402 payment leg.",
        authorizationUsed: usage.authorizationUsed,
        feeAuthorizationUsed: usage.feeAuthorizationUsed,
        balance: usage.balance,
        settlementState: "partial_settlement",
        recoverable: false,
        nextSettlementAction: usage.authorizationUsed ? "resume_protocol_fee" : "resume_seller"
      });
    }

    return verificationSummary(payment, clients, {
      isValid: true,
      authorizationUsed: usage.authorizationUsed,
      feeAuthorizationUsed: usage.feeAuthorizationUsed,
      balance: usage.balance,
      settlementState: fullySettled ? "already_settled" : "partial_settlement",
      recoverable: !fullySettled,
      duplicate: fullySettled,
      ...(fullySettled
        ? {}
        : { nextSettlementAction: usage.authorizationUsed ? "resume_protocol_fee" : "resume_seller" })
    });
  }

  if (usage.authorizationUsed || usage.feeAuthorizationUsed) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: usage.authorizationUsed
        ? "EIP-3009 authorization nonce was already used."
        : "EIP-3009 protocol fee authorization nonce was already used.",
      authorizationUsed: Boolean(usage.authorizationUsed || usage.feeAuthorizationUsed),
      balance: usage.balance
    });
  }

  const requiredBalance = payment.exactFeeSplit?.grossAmount ?? payment.authorization.value;

  if (usage.balance < requiredBalance) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "Payer does not hold enough USDC for the requested x402 payment.",
      authorizationUsed: usage.authorizationUsed,
      balance: usage.balance
    });
  }

  return verificationSummary(payment, clients, {
    isValid: true,
    authorizationUsed: usage.authorizationUsed,
    balance: usage.balance
  });
}

async function verifyHostedPaymentSignatures(payment) {
  const signatureValid = await verifyTypedData({
    address: payment.authorization.from,
    domain: payment.typedData.domain,
    types: payment.typedData.types,
    primaryType: payment.typedData.primaryType,
    message: payment.typedData.message,
    signature: payment.signature
  });
  const feeSignatureValid = payment.exactFeeSplit
    ? await verifyTypedData({
        address: payment.feeAuthorization.from,
        domain: payment.feeTypedData.domain,
        types: payment.feeTypedData.types,
        primaryType: payment.feeTypedData.primaryType,
        message: payment.feeTypedData.message,
        signature: payment.feeSignature
      })
    : true;

  return { signatureValid, feeSignatureValid };
}

async function readHostedPaymentUsage(clients, payment) {
  const [authorizationUsed, feeAuthorizationUsed, balance] = await Promise.all([
    readAuthorizationState(clients, payment),
    payment.exactFeeSplit
      ? readAuthorizationState(clients, payment, payment.feeAuthorization)
      : Promise.resolve(false),
    readBalance(clients, payment)
  ]);

  return { authorizationUsed, feeAuthorizationUsed, balance };
}

function receiptPayload(receipt) {
  return {
    status: receipt.status,
    blockHash: receipt.blockHash,
    blockNumber:
      typeof receipt.blockNumber === "bigint"
        ? receipt.blockNumber.toString()
        : receipt.blockNumber
  };
}

function assertTransactionReceiptSuccess(receipt, label) {
  if (receipt?.status === "reverted") {
    throw new Error(`${label} transaction reverted.`);
  }

  return receipt;
}

async function waitForTransactionReceiptSuccess(clients, hash, label) {
  if (!hash || typeof clients.publicClient.waitForTransactionReceipt !== "function") {
    return null;
  }

  const receipt = await retryTransientRpc(clients, "waitForTransactionReceipt", async () => {
    return await clients.publicClient.waitForTransactionReceipt({ hash });
  });
  return assertTransactionReceiptSuccess(receipt, label);
}

function settlementSuccessPayload(input) {
  const { clients, payment, transactionHash, feeTransactionHash, receipt, feeReceipt } = input;
  return {
    success: true,
    network: payment.networkId,
    payer: payment.payer,
    payTo: payment.payTo,
    relayer: clients.account.address,
    settlementModel: payment.settlementModel ?? "x402-exact-evm-v1",
    ...(transactionHash ? { transaction: transactionHash, txHash: transactionHash, transactionHash } : {}),
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
    ...(payment.exactFeeSplit
      ? {
          feeSplit: {
            feeBps: payment.exactFeeSplit.feeBps,
            grossAmount: payment.exactFeeSplit.grossAmount.toString(),
            sellerAmount: payment.exactFeeSplit.sellerAmount.toString(),
            protocolFeeAmount: payment.exactFeeSplit.protocolFeeAmount.toString(),
            sellerPayTo: payment.exactFeeSplit.sellerPayTo,
            protocolFeePayTo: payment.exactFeeSplit.protocolFeePayTo,
            feeSettlementMode: payment.exactFeeSplit.feeSettlementMode
          }
        }
      : {}),
    ...(feeTransactionHash
      ? {
          protocolFeeTransaction: feeTransactionHash,
          protocolFeeTxHash: feeTransactionHash,
          transactionHashes: {
            protocolFee: feeTransactionHash,
            ...(transactionHash ? { seller: transactionHash } : {})
          }
        }
      : {}),
    ...(receipt ? { receipt: receiptPayload(receipt) } : {}),
    ...(feeReceipt ? { protocolFeeReceipt: receiptPayload(feeReceipt) } : {})
  };
}

function canTreatUsedAuthorizationAsSettled(payment, usage) {
  return Boolean(
    !payment.reserveRelease &&
      usage?.authorizationUsed &&
      (!payment.exactFeeSplit || usage?.feeAuthorizationUsed)
  );
}

async function settleHostedPayment(clients, input) {
  const payment = normalizeHostedExactPayment(input);
  const signatures = await verifyHostedPaymentSignatures(payment);

  if (!signatures.signatureValid || !signatures.feeSignatureValid) {
    return {
      success: false,
      errorReason: signatures.signatureValid
        ? "EIP-3009 protocol fee signature verification failed."
        : "EIP-3009 signature verification failed.",
      verification: verificationSummary(payment, clients, {
        isValid: false,
        invalidReason: signatures.signatureValid
          ? "EIP-3009 protocol fee signature verification failed."
          : "EIP-3009 signature verification failed.",
        authorizationUsed: false,
        balance: 0n
      })
    };
  }

  const initialUsage = await readHostedPaymentUsage(clients, payment);
  const outstandingAmount =
    (initialUsage.authorizationUsed ? 0n : payment.authorization.value) +
    (payment.exactFeeSplit && !initialUsage.feeAuthorizationUsed ? payment.feeAuthorization.value : 0n);

  if (outstandingAmount > 0n && initialUsage.balance < outstandingAmount) {
    const verification = verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "Payer does not hold enough USDC for the unsettled x402 payment leg.",
      authorizationUsed: Boolean(initialUsage.authorizationUsed || initialUsage.feeAuthorizationUsed),
      balance: initialUsage.balance
    });
    return {
      success: false,
      errorReason: verification.invalidReason,
      verification
    };
  }

  const verification = verificationSummary(payment, clients, {
    isValid: true,
    authorizationUsed: Boolean(initialUsage.authorizationUsed || initialUsage.feeAuthorizationUsed),
    balance: initialUsage.balance
  });

  if (canTreatUsedAuthorizationAsSettled(payment, initialUsage)) {
    return {
      ...settlementSuccessPayload({
        clients,
        payment,
        transactionHash: null,
        feeTransactionHash: null,
        receipt: null,
        feeReceipt: null
      }),
      duplicate: true,
      settlementState: "already_settled",
      verification
    };
  }

  const { v, r, s } = parseSignature(payment.signature);
  const feeSignature = payment.exactFeeSplit ? parseSignature(payment.feeSignature) : null;

  try {
    const broadcast = await withRelayerSettlementQueue(clients, async () => {
      const transactionManager = clients.transactionManager ??= createRelayerTransactionManager(clients);
      let feeTransactionHash = null;
      let feeReceipt = null;
      let transactionHash = null;

      if (payment.reserveRelease) {
        transactionHash = await transactionManager.writeContract({
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
        });
      } else if (payment.exactFeeSplit) {
        if (!initialUsage.feeAuthorizationUsed) {
          feeTransactionHash = await transactionManager.writeContract({
            account: clients.account,
            chain: clients.chain,
            address: payment.tokenAddress,
            abi: USDC_EIP3009_ABI,
            functionName: "transferWithAuthorization",
            args: [
              payment.feeAuthorization.from,
              payment.feeAuthorization.to,
              payment.feeAuthorization.value,
              payment.feeAuthorization.validAfter,
              payment.feeAuthorization.validBefore,
              payment.feeAuthorization.nonce,
              feeSignature.v,
              feeSignature.r,
              feeSignature.s
            ]
          });
          feeReceipt = await waitForTransactionReceiptSuccess(
            clients,
            feeTransactionHash,
            "Protocol fee"
          );
        }

        if (!initialUsage.authorizationUsed) {
          transactionHash = await transactionManager.writeContract({
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
        }
      } else {
        transactionHash = await transactionManager.writeContract({
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
      }

      return { transactionHash, feeTransactionHash, feeReceipt };
    });

    const receipt = await waitForTransactionReceiptSuccess(
      clients,
      broadcast.transactionHash,
      payment.reserveRelease ? "Reserve-release" : "Settlement"
    );

    return {
      ...settlementSuccessPayload({
        clients,
        payment,
        transactionHash: broadcast.transactionHash,
        feeTransactionHash: broadcast.feeTransactionHash,
        receipt,
        feeReceipt: broadcast.feeReceipt
      }),
      ...(initialUsage.authorizationUsed || initialUsage.feeAuthorizationUsed
        ? {
            resumed: true,
            settlementState: "resumed"
          }
        : {}),
      verification
    };
  } catch (error) {
    if (isRelayerSettlementLockError(error)) {
      return {
        success: false,
        errorReason: error.message,
        errorCode: error.errorCode ?? "relayer_lock_unavailable",
        settlementState: "settlement_pending",
        recoverable: error.recoverable !== false,
        ...(Number.isFinite(Number(error.retryAfterMs)) ? { retryAfterMs: Number(error.retryAfterMs) } : {}),
        relayer: clients.account.address,
        verification
      };
    }

    const authorizationUsed = await readAuthorizationState(clients, payment).catch(() => false);
    const feeAuthorizationUsed =
      payment.exactFeeSplit
        ? await readAuthorizationState(clients, payment, payment.feeAuthorization).catch(() => false)
        : false;
    if (canTreatUsedAuthorizationAsSettled(payment, { authorizationUsed, feeAuthorizationUsed })) {
      return {
        ...settlementSuccessPayload({
          clients,
          payment,
          transactionHash: null,
          feeTransactionHash: null,
          receipt: null,
          feeReceipt: null
        }),
        duplicate: true,
        settlementState: "already_settled_after_error",
        verification: {
          ...verification,
          authorizationUsed: true
        }
      };
    }

    const decodedError = decodeKnownExecutionError(error);
    const relayerNonceConflict = isRelayerNonceConflictError(error);
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
        : relayerNonceConflict
          ? {
              errorCode: "relayer_nonce_conflict",
              settlementState: "settlement_pending",
              recoverable: true,
              retryAfterMs: 2500,
              relayer: clients.account.address
            }
          : authorizationUsed
            ? { errorCode: "authorization_used" }
            : { errorCode: "settlement_failed" }),
      verification: {
        ...verification,
        authorizationUsed: Boolean(authorizationUsed || feeAuthorizationUsed),
        ...(payment.exactFeeSplit ? { feeAuthorizationUsed } : {})
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

function facilitatorOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Zeko x402 hosted EVM facilitator",
      version: facilitatorVersionInfo().version,
      description: "Verify and settle signed EVM x402 payment payloads."
    },
    paths: {
      "/health": { get: { summary: "Service health and version metadata" } },
      "/version": { get: { summary: "Service version metadata" } },
      "/supported": { get: { summary: "Supported EVM networks and redacted RPC configuration" } },
      "/verify": {
        post: {
          summary: "Verify a signed EVM x402 payment payload",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FacilitatorPaymentRequest" }
              }
            }
          }
        }
      },
      "/settle": {
        post: {
          summary: "Settle a verified signed EVM x402 payment payload",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FacilitatorPaymentRequest" }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        FacilitatorPaymentRequest: {
          type: "object",
          required: ["paymentPayload", "paymentRequirements"],
          properties: {
            paymentPayload: {
              type: "object",
              required: ["protocol", "networkId", "settlementRail", "payTo", "accepted", "payload"],
              properties: {
                protocol: { const: "x402" },
                networkId: { type: "string", examples: ["eip155:8453"] },
                settlementRail: { const: "evm" },
                payTo: { type: "string", description: "Seller or escrow recipient address" },
                accepted: {
                  type: "object",
                  required: ["asset", "amount"],
                  properties: {
                    asset: { type: "string", description: "ERC-20 token address string" },
                    amount: { type: "string", description: "Atomic unit amount as a base-10 string" }
                  }
                },
                payload: {
                  type: "object",
                  description: "Signed EIP-3009 authorization envelope. For exact fee-split rails, include feeAuthorization too."
                }
              }
            },
            paymentRequirements: {
              type: "object",
              description: "The resource's advertised x402 payment requirements."
            }
          }
        }
      }
    }
  };
}

function facilitatorDocsPayload() {
  return {
    service: "zeko-x402-evm-facilitator",
    routes: {
      "GET /health": "Health, version, and supported network metadata.",
      "GET /supported": "Supported EVM network and redacted RPC metadata.",
      "GET /openapi.json": "Machine-readable OpenAPI description.",
      "POST /verify": "Verify a signed EVM x402 payment payload.",
      "POST /settle": "Settle a signed EVM x402 payment payload."
    },
    requestShape: {
      paymentPayload: {
        protocol: "x402",
        networkId: "eip155:8453",
        settlementRail: "evm",
        payTo: "0x...",
        accepted: {
          asset: "0x...",
          amount: "250000"
        },
        payload: {
          authorization: "EIP-3009 typed-data authorization envelope"
        }
      },
      paymentRequirements: "The payment requirements object advertised by the protected resource."
    },
    notes: [
      "Do not post the payment requirements object as paymentPayload.",
      "accepted.asset must be the ERC-20 token address string.",
      "Validation errors return HTTP 400 with errorCode=invalid_request."
    ]
  };
}

function facilitatorHttpErrorStatus(error) {
  if (error instanceof SyntaxError) {
    return 400;
  }
  if (isRelayerSettlementLockError(error)) {
    return error.recoverable === false ? 500 : 503;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /is required|must be|requires|does not match|unsupported|unknown network|fee split|paymentPayload|paymentRequirements|authorization|signature|typedData|accepted\.|payload\.|asset\.|scheme=|networkId|payTo|payer|token address|amount string|base-10 integer|invalid_request|invalid amount|invalid atomic amount|invalid asset decimals|invalid address|invalid payment|invalid authorization|invalid signature/i.test(
      message
    )
  ) {
    return 400;
  }
  return 500;
}

function facilitatorHttpErrorBody(error) {
  const statusCode = facilitatorHttpErrorStatus(error);
  const message = error instanceof Error ? error.message : "unexpected_error";
  return {
    ok: false,
    error: message,
    errorCode:
      statusCode === 400
        ? "invalid_request"
        : isRelayerSettlementLockError(error)
          ? error.errorCode
          : "unexpected_error",
    ...(statusCode === 400
      ? { expectedShape: "POST { paymentPayload, paymentRequirements }. See GET /docs or /openapi.json." }
      : {}),
    ...(isRelayerSettlementLockError(error) && Number.isFinite(Number(error.retryAfterMs))
      ? { retryAfterMs: Number(error.retryAfterMs) }
      : {})
  };
}

export function facilitatorVersionInfo() {
  const commitSha =
    process.env.RENDER_GIT_COMMIT ??
    process.env.GIT_COMMIT ??
    process.env.COMMIT_SHA ??
    process.env.SOURCE_VERSION ??
    null;
  return {
    ok: true,
    service: "zeko-x402-evm-facilitator",
    version: "0.1.0",
    commitSha,
    source: commitSha ? "env" : "unavailable"
  };
}

export class SelfHostedEvmFacilitator {
  constructor(input = {}) {
    const networks = Array.isArray(input.networks) ? input.networks : [];

    if (networks.length === 0) {
      throw new Error("SelfHostedEvmFacilitator requires at least one configured EVM network.");
    }

    this.networks = new Map(
      networks.map((network) => [
        network.networkId,
        makeClients({
          ...network,
          relayerSettlementLock: network.relayerSettlementLock ?? input.relayerSettlementLock ?? null
        })
      ])
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
        rpcUrl: redactRpcUrl(entry.rpcUrl),
        rpcUrls: entry.rpcUrls.map(redactRpcUrl),
        rpcRetryCount: entry.rpcRetryCount,
        rpcRetryDelayMs: entry.rpcRetryDelayMs,
        rpcTimeoutMs: entry.rpcTimeoutMs,
        relayer: entry.account.address,
        relayerSettlementCoordination: relayerSettlementLockInfo(entry.relayerSettlementLock)
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
        sendJson(response, 200, facilitatorVersionInfo());
        return;
      }

      if (request.method === "GET" && url.pathname === "/version") {
        sendJson(response, 200, facilitatorVersionInfo());
        return;
      }

      if (request.method === "GET" && url.pathname === "/supported") {
        sendJson(response, 200, await facilitator.supported());
        return;
      }

      if (request.method === "GET" && url.pathname === "/docs") {
        sendJson(response, 200, facilitatorDocsPayload());
        return;
      }

      if (request.method === "GET" && url.pathname === "/openapi.json") {
        sendJson(response, 200, facilitatorOpenApiDocument());
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
      sendJson(response, facilitatorHttpErrorStatus(error), facilitatorHttpErrorBody(error));
    }
  });
}
