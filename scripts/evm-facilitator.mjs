import { createSelfHostedEvmFacilitatorHttpServer } from "../src/index.js";

function readOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
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
          rpcUrls: network.rpcUrls ?? [network.rpcUrl]
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
