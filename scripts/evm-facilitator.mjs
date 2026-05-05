import { createSelfHostedEvmFacilitatorHttpServer } from "../src/index.js";

const SHARED_PUBLIC_RPC_HOSTS = new Set([
  "mainnet.base.org",
  "base-rpc.publicnode.com",
  "ethereum.publicnode.com",
  "rpc.ankr.com"
]);

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

function readOptionalEnvList(names) {
  for (const name of names) {
    const value = readOptionalEnv(name);

    if (!value) {
      continue;
    }

    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function rpcHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
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
    .map(({ network }) => `${network.networkId}: ${(network.rpcUrls ?? [network.rpcUrl]).join(", ")}`)
    .join("; ");
  throw new Error(
    `Hosted EVM facilitator needs a reliable RPC provider or fallback list; single shared public RPC is unsafe (${details}). ` +
      "Set X402_BASE_RPC_URLS or X402_ETHEREUM_RPC_URLS to a private/dedicated RPC first, optionally followed by a public fallback. " +
      "For local-only experiments, set X402_EVM_ALLOW_SHARED_PUBLIC_RPC=true."
  );
}

function buildNetworkConfigs() {
  const requested = readOptionalEnv("X402_EVM_NETWORK", "base").toLowerCase();
  const genericRpcUrls = readOptionalEnvList(["X402_EVM_RPC_URLS", "X402_EVM_RPC_URL"]);
  const genericRelayerPrivateKey = readOptionalEnv(
    "X402_EVM_RELAYER_PRIVATE_KEY",
    readOptionalEnv("EVM_RELAYER_PRIVATE_KEY")
  );
  const configs = [];

  const baseRpcUrls = readOptionalEnvList(["X402_BASE_RPC_URLS", "X402_BASE_RPC_URL", "BASE_RPC_URL"]);
  const baseRelayerPrivateKey = readOptionalEnv(
    "X402_BASE_RELAYER_PRIVATE_KEY",
    genericRelayerPrivateKey
  );

  if (baseRpcUrls.length > 0 && baseRelayerPrivateKey) {
    configs.push({
      networkId: "eip155:8453",
      rpcUrl: baseRpcUrls[0],
      rpcUrls: baseRpcUrls,
      relayerPrivateKey: baseRelayerPrivateKey
    });
  }

  const ethereumRpcUrls = readOptionalEnvList([
    "X402_ETHEREUM_RPC_URLS",
    "X402_ETHEREUM_RPC_URL",
    "ETHEREUM_RPC_URL"
  ]);
  const ethereumRelayerPrivateKey = readOptionalEnv(
    "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
    genericRelayerPrivateKey
  );

  if (ethereumRpcUrls.length > 0 && ethereumRelayerPrivateKey) {
    configs.push({
      networkId: "eip155:1",
      rpcUrl: ethereumRpcUrls[0],
      rpcUrls: ethereumRpcUrls,
      relayerPrivateKey: ethereumRelayerPrivateKey
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
      relayerPrivateKey: genericRelayerPrivateKey
    }
  ];
}

async function main() {
  const host = readOptionalEnv("X402_EVM_FACILITATOR_HOST", "127.0.0.1");
  const port = Number(readOptionalEnv("X402_EVM_FACILITATOR_PORT", "7422"));

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("X402_EVM_FACILITATOR_PORT must be a positive integer.");
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
          rpcUrl: network.rpcUrl,
          rpcUrls: network.rpcUrls ?? [network.rpcUrl],
          rpcPolicy: describeRpcPolicy(network)
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
