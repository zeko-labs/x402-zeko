import { createSelfHostedEvmFacilitatorHttpServer } from "../src/index.js";

const SHARED_PUBLIC_RPC_HOSTS = new Set([
  "mainnet.base.org",
  "base-rpc.publicnode.com",
  "ethereum.publicnode.com",
  "rpc.ankr.com"
]);
const BASE_RPC_ENV_NAMES = [
  "X402_BASE_RPC_URLS",
  "X402_BASE_RPC_URL",
  "BASE_RPC_URL",
  "X402_BASE_MAINNET_RPC_URL",
  "BASE_MAINNET_RPC_URL",
  "BASE_RPC_HTTP_URL",
  "QUICKNODE_BASE_RPC_URL",
  "QUICKNODE_RPC_URL",
  "ALCHEMY_BASE_RPC_URL",
  "ALCHEMY_RPC_URL",
  "RPC_URL"
];
const ETHEREUM_RPC_ENV_NAMES = [
  "X402_ETHEREUM_RPC_URLS",
  "X402_ETHEREUM_RPC_URL",
  "ETHEREUM_RPC_URL",
  "X402_ETHEREUM_MAINNET_RPC_URL",
  "ETHEREUM_MAINNET_RPC_URL",
  "ETHEREUM_RPC_HTTP_URL",
  "QUICKNODE_ETHEREUM_RPC_URL",
  "ALCHEMY_ETHEREUM_RPC_URL"
];
const GENERIC_EVM_RPC_ENV_NAMES = ["X402_EVM_RPC_URLS", "X402_EVM_RPC_URL"];

function readOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function envFlagEnabled(name) {
  const value = readOptionalEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function envFlagDisabled(name) {
  const value = readOptionalEnv(name).toLowerCase();
  return value === "0" || value === "false" || value === "no";
}

function readPositiveIntEnv(name, fallback) {
  const parsed = Number(readOptionalEnv(name));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntEnv(name, fallback) {
  const parsed = Number(readOptionalEnv(name));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function detectedEnvNames(names) {
  return names.filter((name) => readOptionalEnv(name));
}

function readRpcEnvList(names) {
  const values = [];

  for (const name of names) {
    const value = readOptionalEnv(name);

    if (!value) {
      continue;
    }

    values.push(
      ...value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  }

  const seen = new Set();
  const unique = values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  });

  return [
    ...unique.filter((value) => !isSharedPublicRpc(value)),
    ...unique.filter((value) => isSharedPublicRpc(value))
  ];
}

function rpcHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
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

function isSharedPublicRpc(value) {
  return SHARED_PUBLIC_RPC_HOSTS.has(rpcHost(value));
}

function isHostedRuntime(host) {
  if (envFlagEnabled("X402_EVM_FACILITATOR_REQUIRE_PRODUCTION_RPC")) {
    return true;
  }

  if (envFlagDisabled("X402_EVM_FACILITATOR_REQUIRE_PRODUCTION_RPC")) {
    return false;
  }

  return (
    host === "0.0.0.0" ||
    readOptionalEnv("NODE_ENV").toLowerCase() === "production" ||
    envFlagEnabled("RENDER")
  );
}

function describeRpcPolicy(network) {
  const rpcUrls = Array.isArray(network.rpcUrls) ? network.rpcUrls : [network.rpcUrl].filter(Boolean);
  const sharedPublicUrls = rpcUrls.filter(isSharedPublicRpc);
  const hasPrivateOrDedicatedRpc = rpcUrls.some((url) => !isSharedPublicRpc(url));

  return {
    rpcCount: rpcUrls.length,
    sharedPublicRpcCount: sharedPublicUrls.length,
    hasPrivateOrDedicatedRpc,
    productionReady: hasPrivateOrDedicatedRpc || rpcUrls.length > 1
  };
}

function assertHostedRpcPolicy(networks, { host }) {
  if (!isHostedRuntime(host) || envFlagEnabled("X402_EVM_ALLOW_SHARED_PUBLIC_RPC")) {
    return;
  }

  const unsafe = networks
    .map((network) => ({ network, policy: describeRpcPolicy(network) }))
    .filter(({ policy }) => !policy.productionReady);

  if (unsafe.length === 0) {
    return;
  }

  const details = unsafe
    .map(
      ({ network }) =>
        `${network.networkId}: ${(network.rpcUrls ?? [network.rpcUrl]).map(redactRpcUrl).join(", ")} ` +
        `(detected envs: ${network.rpcEnvNames?.length ? network.rpcEnvNames.join(", ") : "none"})`
    )
    .join("; ");
  throw new Error(
    `Hosted EVM facilitator needs a reliable RPC provider or fallback list; single shared public RPC is unsafe (${details}). ` +
      "Set X402_BASE_RPC_URLS or X402_ETHEREUM_RPC_URLS to a private/dedicated RPC first, optionally followed by a public fallback. " +
      "For local-only experiments, set X402_EVM_ALLOW_SHARED_PUBLIC_RPC=true."
  );
}

function buildNetworkConfigs() {
  const requested = readOptionalEnv("X402_EVM_NETWORK", "base").toLowerCase();
  const genericRpcUrls = readRpcEnvList(GENERIC_EVM_RPC_ENV_NAMES);
  const genericRpcEnvNames = detectedEnvNames(GENERIC_EVM_RPC_ENV_NAMES);
  const genericRelayerPrivateKey = readOptionalEnv(
    "X402_EVM_RELAYER_PRIVATE_KEY",
    readOptionalEnv("EVM_RELAYER_PRIVATE_KEY")
  );
  const rpcRuntimeConfig = {
    rpcRetryCount: readNonNegativeIntEnv("X402_EVM_RPC_RETRY_COUNT", 2),
    rpcRetryDelayMs: readPositiveIntEnv("X402_EVM_RPC_RETRY_DELAY_MS", 250),
    rpcTimeoutMs: readPositiveIntEnv("X402_EVM_RPC_TIMEOUT_MS", 10_000)
  };
  const configs = [];

  const baseRpcEnvNames = [...BASE_RPC_ENV_NAMES, ...GENERIC_EVM_RPC_ENV_NAMES];
  const baseRpcUrls = readRpcEnvList(baseRpcEnvNames);
  const baseRelayerPrivateKey = readOptionalEnv(
    "X402_BASE_RELAYER_PRIVATE_KEY",
    genericRelayerPrivateKey
  );

  if (baseRpcUrls.length > 0 && baseRelayerPrivateKey) {
    configs.push({
      networkId: "eip155:8453",
      rpcUrl: baseRpcUrls[0],
      rpcUrls: baseRpcUrls,
      rpcEnvNames: detectedEnvNames(baseRpcEnvNames),
      relayerPrivateKey: baseRelayerPrivateKey,
      ...rpcRuntimeConfig
    });
  }

  const ethereumRpcEnvNames = [...ETHEREUM_RPC_ENV_NAMES, ...GENERIC_EVM_RPC_ENV_NAMES];
  const ethereumRpcUrls = readRpcEnvList(ethereumRpcEnvNames);
  const ethereumRelayerPrivateKey = readOptionalEnv(
    "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
    genericRelayerPrivateKey
  );

  if (ethereumRpcUrls.length > 0 && ethereumRelayerPrivateKey) {
    configs.push({
      networkId: "eip155:1",
      rpcUrl: ethereumRpcUrls[0],
      rpcUrls: ethereumRpcUrls,
      rpcEnvNames: detectedEnvNames(ethereumRpcEnvNames),
      relayerPrivateKey: ethereumRelayerPrivateKey,
      ...rpcRuntimeConfig
    });
  }

  if (configs.length > 0) {
    return configs;
  }

  const selectedNetworkId =
    requested === "ethereum" || requested === "eth" || requested === "mainnet" || requested === "eip155:1"
      ? "eip155:1"
      : "eip155:8453";

  if (genericRpcUrls.length === 0 || !genericRelayerPrivateKey) {
    throw new Error(
      "Configure either per-network RPC/relayer env vars or X402_EVM_RPC_URL(S) + X402_EVM_RELAYER_PRIVATE_KEY."
    );
  }

  return [
    {
      networkId: selectedNetworkId,
      rpcUrl: genericRpcUrls[0],
      rpcUrls: genericRpcUrls,
      rpcEnvNames: genericRpcEnvNames,
      relayerPrivateKey: genericRelayerPrivateKey,
      ...rpcRuntimeConfig
    }
  ];
}

async function main() {
  const host = readOptionalEnv("X402_EVM_FACILITATOR_HOST", "127.0.0.1");
  const port = Number(readOptionalEnv("X402_EVM_FACILITATOR_PORT", readOptionalEnv("PORT", "7422")));

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("X402_EVM_FACILITATOR_PORT or PORT must be a positive integer.");
  }

  const networks = buildNetworkConfigs();
  assertHostedRpcPolicy(networks, { host });
  const server = createSelfHostedEvmFacilitatorHttpServer({ networks });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        host,
        port,
        baseUrl: `http://${host}:${port}`,
        networks: networks.map((network) => ({
          networkId: network.networkId,
          rpcEnvNames: network.rpcEnvNames ?? [],
          rpcUrl: redactRpcUrl(network.rpcUrl),
          rpcUrls: (network.rpcUrls ?? [network.rpcUrl]).map(redactRpcUrl),
          rpcPolicy: describeRpcPolicy(network),
          rpcRetryCount: network.rpcRetryCount,
          rpcRetryDelayMs: network.rpcRetryDelayMs,
          rpcTimeoutMs: network.rpcTimeoutMs
        }))
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[zeko-x402:evm-facilitator] failed", error);
  process.exit(1);
});
