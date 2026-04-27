import {
  CDPFacilitatorClient,
  HostedX402FacilitatorClient,
  InMemorySettlementLedger,
  SelfHostedEvmFacilitator,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  buildBaseMainnetUsdcRail,
  buildBaseUsdcExactEip3009Intent,
  buildCatalog,
  buildEthereumMainnetUsdcExactEip3009Intent,
  buildEthereumMainnetUsdcRail,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSettlementResponse,
  buildSignedEvmAuthorization,
  encodeBase64Json,
  verifyPayment
} from "../src/index.js";
import { privateKeyToAccount } from "viem/accounts";

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

function requireOneOfEnv(names) {
  for (const name of names) {
    const value = readOptionalEnv(name);

    if (value) {
      return value;
    }
  }

  throw new Error(`One of ${names.join(", ")} must be set.`);
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}`;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function resolvePayTo(network) {
  if (network.name === "base") {
    return readOptionalEnv(
      "X402_BASE_PAY_TO",
      readOptionalEnv(
        "X402_EVM_PAY_TO",
        readOptionalEnv("X402_BASE_TREASURY_ADDRESS", readOptionalEnv("X402_EVM_TREASURY_ADDRESS"))
      )
    );
  }

  if (network.name === "ethereum") {
    return readOptionalEnv(
      "X402_ETHEREUM_PAY_TO",
      readOptionalEnv(
        "X402_EVM_PAY_TO",
        readOptionalEnv(
          "X402_ETHEREUM_TREASURY_ADDRESS",
          readOptionalEnv("X402_EVM_TREASURY_ADDRESS")
        )
      )
    );
  }

  return readOptionalEnv("X402_EVM_PAY_TO", readOptionalEnv("X402_EVM_TREASURY_ADDRESS"));
}

function resolveAmount(network) {
  if (network.name === "base") {
    return readOptionalEnv("X402_BASE_USDC_AMOUNT", readOptionalEnv("X402_EVM_AMOUNT", "0.50"));
  }

  if (network.name === "ethereum") {
    return readOptionalEnv(
      "X402_ETHEREUM_USDC_AMOUNT",
      readOptionalEnv("X402_EVM_AMOUNT", "0.50")
    );
  }

  return readOptionalEnv("X402_EVM_AMOUNT", "0.50");
}

function resolveSelfHostedConfig(network) {
  const rpcUrls =
    network.name === "base"
      ? readOptionalEnvList(["X402_BASE_RPC_URLS", "X402_BASE_RPC_URL", "BASE_RPC_URL", "X402_EVM_RPC_URLS", "X402_EVM_RPC_URL"])
      : network.name === "ethereum"
        ? readOptionalEnvList([
            "X402_ETHEREUM_RPC_URLS",
            "X402_ETHEREUM_RPC_URL",
            "ETHEREUM_RPC_URL",
            "X402_EVM_RPC_URLS",
            "X402_EVM_RPC_URL"
          ])
        : readOptionalEnvList(["X402_EVM_RPC_URLS", "X402_EVM_RPC_URL"]);
  const relayerPrivateKey = readOptionalEnv(
    network.name === "base"
      ? "X402_BASE_RELAYER_PRIVATE_KEY"
      : network.name === "ethereum"
        ? "X402_ETHEREUM_RELAYER_PRIVATE_KEY"
        : "X402_EVM_RELAYER_PRIVATE_KEY",
    readOptionalEnv("X402_EVM_RELAYER_PRIVATE_KEY", readOptionalEnv("EVM_RELAYER_PRIVATE_KEY"))
  );

  return {
    rpcUrl: rpcUrls[0] ?? null,
    rpcUrls,
    relayerPrivateKey,
    relayerAddress: relayerPrivateKey
      ? privateKeyToAccount(
          relayerPrivateKey.startsWith("0x") ? relayerPrivateKey : `0x${relayerPrivateKey}`
        ).address
      : null,
    ready: Boolean(rpcUrls.length > 0 && relayerPrivateKey)
  };
}

function collectMissingConfig(network, input) {
  const missing = [];

  if (!input.evmPrivateKey) {
    missing.push("X402_EVM_PRIVATE_KEY or EVM_PRIVATE_KEY");
  }

  if (!input.payTo) {
    missing.push("X402_*_PAY_TO");
  }

  if (network.defaultFacilitator === "cdp") {
    if (!input.facilitatorUrl && !input.bearerToken && !input.selfHosted?.ready) {
      missing.push(
        "CDP_API_BEARER_TOKEN or X402_EVM_FACILITATOR_URL or (X402_EVM_RPC_URL and X402_EVM_RELAYER_PRIVATE_KEY)"
      );
    }
  } else if (!input.facilitatorUrl && !input.selfHosted?.ready) {
    missing.push("X402_EVM_FACILITATOR_URL or (X402_EVM_RPC_URL and X402_EVM_RELAYER_PRIVATE_KEY)");
  }

  return missing;
}

function selectNetwork() {
  const requested = readOptionalEnv("X402_EVM_NETWORK", "base").toLowerCase();

  if (requested === "base" || requested === "eip155:8453") {
    return {
      name: "base",
      networkId: "eip155:8453",
      railBuilder: buildBaseMainnetUsdcRail,
      intentBuilder: buildBaseUsdcExactEip3009Intent,
      defaultFacilitator: "cdp"
    };
  }

  if (
    requested === "ethereum" ||
    requested === "eth" ||
    requested === "mainnet" ||
    requested === "eip155:1"
  ) {
    return {
      name: "ethereum",
      networkId: "eip155:1",
      railBuilder: buildEthereumMainnetUsdcRail,
      intentBuilder: buildEthereumMainnetUsdcExactEip3009Intent,
      defaultFacilitator: "custom"
    };
  }

  throw new Error(`Unsupported X402_EVM_NETWORK: ${requested}`);
}

function buildFacilitator(network, input) {
  if (!input.facilitatorUrl && !input.bearerToken && input.selfHosted?.ready) {
    return new SelfHostedEvmFacilitator({
      networks: [
        {
          networkId: network.networkId,
          rpcUrl: input.selfHosted.rpcUrl,
          rpcUrls: input.selfHosted.rpcUrls,
          relayerPrivateKey: input.selfHosted.relayerPrivateKey
        }
      ]
    });
  }

  if (network.defaultFacilitator === "cdp" && !input.facilitatorUrl) {
    return new CDPFacilitatorClient({
      bearerToken: input.bearerToken
    });
  }

  if (!input.facilitatorUrl) {
    throw new Error(
      `Network ${network.networkId} requires X402_EVM_FACILITATOR_URL because the default CDP facilitator does not currently support it.`
    );
  }

  return new HostedX402FacilitatorClient({
    baseUrl: input.facilitatorUrl,
    bearerToken: input.bearerToken,
    requireAuth: typeof input.bearerToken === "string" && input.bearerToken.length > 0,
    enforceKnownNetworks: false
  });
}

async function main() {
  const network = selectNetwork();
  const evmPrivateKeyValue = readOptionalEnv("X402_EVM_PRIVATE_KEY", readOptionalEnv("EVM_PRIVATE_KEY"));
  const payTo = resolvePayTo(network);
  const amount = resolveAmount(network);
  const serviceId = readOptionalEnv("X402_SERVICE_ID", "zeko-x402-evm-smoke");
  const sessionId = readOptionalEnv("X402_SESSION_ID", createId("session"));
  const turnId = readOptionalEnv("X402_TURN_ID", createId("turn"));
  const paymentId = readOptionalEnv("X402_PAYMENT_ID", createId("pay"));
  const baseUrl = readOptionalEnv("X402_BASE_URL", "http://127.0.0.1:7421");
  const proofBundleUrl = readOptionalEnv(
    "X402_PROOF_BUNDLE_URL",
    `${baseUrl}/proof-bundles/${sessionId}.json`
  );
  const verifyUrl = readOptionalEnv("X402_VERIFY_URL", `${baseUrl}/verify/${sessionId}`);
  const facilitatorUrl = readOptionalEnv("X402_EVM_FACILITATOR_URL");
  const bearerToken = readOptionalEnv("X402_EVM_BEARER_TOKEN", readOptionalEnv("CDP_API_BEARER_TOKEN"));
  const selfHosted = resolveSelfHostedConfig(network);
  const routingMode =
    payTo && selfHosted.relayerAddress
      ? payTo.toLowerCase() === selfHosted.relayerAddress.toLowerCase()
        ? "co-located"
        : "split"
      : null;
  const missing = collectMissingConfig(network, {
    evmPrivateKey: evmPrivateKeyValue,
    payTo,
    facilitatorUrl,
    bearerToken,
    selfHosted
  });

  if (missing.length > 0) {
    throw new Error(`Missing EVM smoke configuration: ${missing.join(", ")}`);
  }

  const evmPrivateKey = normalizePrivateKey(
    evmPrivateKeyValue || requireOneOfEnv(["X402_EVM_PRIVATE_KEY", "EVM_PRIVATE_KEY"])
  );

  const account = privateKeyToAccount(evmPrivateKey);
  const rail = network.railBuilder({
    payTo,
    amount,
    ...(facilitatorUrl ? { facilitatorUrl } : {})
  });
  const paymentContext = {
    serviceId,
    sessionId,
    turnId,
    baseUrl,
    proofBundleUrl,
    verifyUrl,
    description: "Smoke-test proof resource negotiated through x402 on an EVM rail.",
    rails: [rail]
  };
  const catalog = buildCatalog(paymentContext);
  const paymentRequired = buildPaymentRequired(paymentContext);
  const accepted = paymentRequired.accepts.find((entry) => entry.network === network.networkId);

  if (!accepted) {
    throw new Error(`No accepted payment rail found for ${network.networkId}.`);
  }

  const intent = network.intentBuilder({
    from: account.address,
    to: payTo,
    amount,
    ...(facilitatorUrl ? { facilitatorUrl } : {})
  });
  const signature = await account.signTypedData({
    domain: intent.typedData.domain,
    types: intent.typedData.types,
    primaryType: intent.typedData.primaryType,
    message: intent.typedData.message
  });
  const authorization = buildSignedEvmAuthorization(intent, { signature });
  const paymentPayload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId,
    option: accepted,
    payer: account.address,
    sessionId,
    turnId,
    authorization
  });
  const localVerification = verifyPayment({
    requirements: paymentRequired,
    payload: paymentPayload
  });

  if (!localVerification.ok) {
    throw new Error(localVerification.reason ?? "Local x402 verification failed.");
  }

  const facilitator = buildFacilitator(network, {
    facilitatorUrl,
    bearerToken,
    selfHosted
  });
  let supported = null;

  try {
    supported = typeof facilitator.supported === "function"
      ? await facilitator.supported()
      : null;
  } catch (error) {
    supported = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const verification = await facilitator.verify({
    paymentPayload,
    paymentRequirements: paymentRequired
  });

  if (verification?.isValid === false || verification?.ok === false) {
    throw new Error(
      verification?.invalidReason ||
      verification?.error ||
      "Hosted facilitator rejected the payment during verification."
    );
  }

  const settlement = await facilitator.settle({
    paymentPayload,
    paymentRequirements: paymentRequired
  });

  if (settlement?.success === false) {
    throw new Error(
      settlement?.errorReason ||
      settlement?.errorMessage ||
      "Hosted facilitator failed to settle the payment."
    );
  }

  const settlementReference =
    settlement?.transaction ||
    settlement?.txHash ||
    settlement?.transactionHash ||
    settlement?.id ||
    null;
  const ledger = new InMemorySettlementLedger({
    sponsoredBudget: readOptionalEnv("X402_SPONSORED_BUDGET_USDC", "10"),
    budgetAsset: accepted.asset
  });
  const ledgerResult = ledger.settle({
    ...paymentPayload,
    resource: paymentRequired.resource,
    ...(settlementReference ? { settlementReference } : {})
  });
  const paymentResponse = buildSettlementResponse({
    payload: paymentPayload,
    duplicate: ledgerResult.duplicate,
    eventIds: ledgerResult.settlement.eventIds,
    settledAtIso: ledgerResult.settlement.settledAtIso,
    remainingBudget: ledgerResult.remainingBudget,
    sponsoredBudget: ledgerResult.sponsoredBudget,
    budgetAsset: ledgerResult.budgetAsset,
    proofBundleUrl,
    verifyUrl,
    settlementModel: accepted.settlementModel,
    settlementReference,
    evm: {
      networkId: accepted.network,
      chainId: accepted.extensions?.evm?.chainId ?? null,
      chainName: accepted.extensions?.evm?.chainName ?? null,
      facilitatorUrl:
        facilitator.baseUrl ??
        accepted.extensions?.evm?.facilitatorUrl ??
        (selfHosted.ready ? "self-hosted" : null),
      verification,
      settlement
    }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        selectedNetwork: network.networkId,
        routing: {
          mode: routingMode,
          payTo,
          relayer: selfHosted.relayerAddress
        },
        supported,
        catalog,
        paymentRequired,
        paymentPayload,
        paymentResponse,
        verification,
        settlement,
        headers: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodeBase64Json(paymentRequired),
          [X402_PAYMENT_SIGNATURE_HEADER]: encodeBase64Json(paymentPayload),
          [X402_PAYMENT_RESPONSE_HEADER]: encodeBase64Json(paymentResponse)
        },
        resource: {
          ok: true,
          sessionId,
          turnId,
          proofBundleUrl,
          verifyUrl,
          settlementReference
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[zeko-x402:smoke-evm-flow] failed", error);
  process.exit(1);
});
