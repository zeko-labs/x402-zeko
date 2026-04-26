import path from "node:path";
import { fileURLToPath } from "node:url";

import { MerkleMap, Mina, PrivateKey, PublicKey, fetchAccount } from "o1js";
import { privateKeyToAccount } from "viem/accounts";

import { X402SettlementContract } from "../dist-zkapp/contracts/X402SettlementContract.js";
import {
  ZEKO_TESTNET_NETWORK,
  computeSettlementStoreRoot,
  readSettlementStore
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMPTY_SETTLEMENT_ROOT = new MerkleMap().getRoot().toString();

function readOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readFirstEnv(names) {
  for (const name of names) {
    const value = readOptionalEnv(name);

    if (value) {
      return { name, value };
    }
  }

  return null;
}

function normalizeBaseUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function normalizeEvmNetwork() {
  const requested = readOptionalEnv("X402_EVM_NETWORK", "base").toLowerCase();

  if (requested === "base" || requested === "eip155:8453") {
    return {
      name: "base",
      networkId: "eip155:8453",
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
      defaultFacilitator: "custom"
    };
  }

  return {
    name: requested,
    networkId: requested,
    defaultFacilitator: "custom"
  };
}

function resolveSelfHostedEvm(network) {
  const rpcUrl =
    network.name === "base"
      ? readOptionalEnv("X402_BASE_RPC_URL", readOptionalEnv("BASE_RPC_URL", readOptionalEnv("X402_EVM_RPC_URL")))
      : network.name === "ethereum"
        ? readOptionalEnv(
            "X402_ETHEREUM_RPC_URL",
            readOptionalEnv("ETHEREUM_RPC_URL", readOptionalEnv("X402_EVM_RPC_URL"))
          )
        : readOptionalEnv("X402_EVM_RPC_URL");
  const relayerPrivateKey = readFirstEnv(
    network.name === "base"
      ? ["X402_BASE_RELAYER_PRIVATE_KEY", "X402_EVM_RELAYER_PRIVATE_KEY", "EVM_RELAYER_PRIVATE_KEY"]
      : network.name === "ethereum"
        ? ["X402_ETHEREUM_RELAYER_PRIVATE_KEY", "X402_EVM_RELAYER_PRIVATE_KEY", "EVM_RELAYER_PRIVATE_KEY"]
        : ["X402_EVM_RELAYER_PRIVATE_KEY", "EVM_RELAYER_PRIVATE_KEY"]
  );

  return {
    ready: Boolean(rpcUrl && relayerPrivateKey),
    rpcUrl: rpcUrl || null,
    relayerKeySource: relayerPrivateKey?.name ?? null,
    relayerAddress: relayerPrivateKey
      ? privateKeyToAccount(
          relayerPrivateKey.value.startsWith("0x") ? relayerPrivateKey.value : `0x${relayerPrivateKey.value}`
        ).address
      : null
  };
}

function resolveEvmPayTo(network) {
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

function inspectEvm() {
  const network = normalizeEvmNetwork();
  const privateKey = readFirstEnv(["X402_EVM_PRIVATE_KEY", "EVM_PRIVATE_KEY"]);
  const payTo = resolveEvmPayTo(network);
  const facilitatorUrl = readOptionalEnv("X402_EVM_FACILITATOR_URL");
  const bearerToken = readOptionalEnv("X402_EVM_BEARER_TOKEN", readOptionalEnv("CDP_API_BEARER_TOKEN"));
  const selfHosted = resolveSelfHostedEvm(network);
  const missing = [];
  const routingMode =
    payTo && selfHosted.relayerAddress
      ? payTo.toLowerCase() === selfHosted.relayerAddress.toLowerCase()
        ? "co-located"
        : "split"
      : null;
  const warnings = [];

  if (!privateKey) {
    missing.push("X402_EVM_PRIVATE_KEY or EVM_PRIVATE_KEY");
  }

  if (!payTo) {
    missing.push("X402_*_PAY_TO");
  }

  if (network.defaultFacilitator === "cdp") {
    if (!facilitatorUrl && !bearerToken && !selfHosted.ready) {
      missing.push(
        "CDP_API_BEARER_TOKEN or X402_EVM_FACILITATOR_URL or (X402_EVM_RPC_URL and X402_EVM_RELAYER_PRIVATE_KEY)"
      );
    }
  } else if (!facilitatorUrl && !selfHosted.ready) {
    missing.push("X402_EVM_FACILITATOR_URL or (X402_EVM_RPC_URL and X402_EVM_RELAYER_PRIVATE_KEY)");
  }

  if (routingMode === "co-located") {
    warnings.push("payTo matches the relayer wallet; production routing should keep the receiving wallet separate.");
  }

  return {
    ready: missing.length === 0,
    network: network.name,
    networkId: network.networkId,
    facilitator:
      facilitatorUrl ||
      (selfHosted.ready ? "self-hosted" : null) ||
      (network.defaultFacilitator === "cdp" ? "coinbase-cdp-default" : "custom-required"),
    payerKeySource: privateKey?.name ?? null,
    payTo: payTo || null,
    selfHosted,
    routingMode,
    warnings,
    missing,
    recommendedAction:
      missing.length === 0
        ? routingMode === "co-located"
          ? "EVM rail is configured, but production routing should move payTo off the relayer wallet."
          : "EVM rail is configured for a live smoke run."
        : network.defaultFacilitator === "cdp"
          ? "Set an EVM private key, an EVM payTo address, and either CDP_API_BEARER_TOKEN, X402_EVM_FACILITATOR_URL, or self-hosted EVM relayer config."
          : "Set an EVM private key, an EVM payTo address, and either a custom X402_EVM_FACILITATOR_URL or self-hosted EVM relayer config for this network."
  };
}

async function readWitnessRoot(input) {
  if (input.witnessServiceUrl) {
    const response = await fetch(`${normalizeBaseUrl(input.witnessServiceUrl)}/root`);
    const body = await response.json();

    if (!response.ok) {
      throw new Error(body?.error ?? `Witness root request failed (${response.status}).`);
    }

    return {
      source: "http",
      location: input.witnessServiceUrl,
      currentRoot: typeof body?.currentRoot === "string" ? body.currentRoot : null,
      entryCount: Number.isInteger(body?.entryCount) ? body.entryCount : null
    };
  }

  const store = await readSettlementStore(input.settlementStatePath);
  return {
    source: "file",
    location: input.settlementStatePath,
    currentRoot: computeSettlementStoreRoot(input.o1js, store).toString(),
    entryCount: store.entries.length
  };
}

async function fetchSettlementEvents(archiveUrl, address) {
  const query = `
    query Events($input: EventFilterOptionsInput!) {
      events(input: $input) {
        blockInfo {
          height
          timestamp
        }
        eventData {
          accountUpdateId
          data
          transactionInfo {
            hash
            memo
            status
            authorizationKind
            sequenceNumber
          }
        }
      }
    }
  `;
  const response = await fetch(archiveUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          address,
          from: 0,
          to: 999999999
        }
      }
    })
  });
  const body = await response.json();

  if (!response.ok || (Array.isArray(body?.errors) && body.errors.length > 0)) {
    throw new Error(
      body?.errors?.[0]?.message ??
      `Archive events query failed (${response.status}).`
    );
  }

  return Array.isArray(body?.data?.events) ? body.data.events : [];
}

async function inspectZeko() {
  const graphql = readOptionalEnv("ZEKO_GRAPHQL", ZEKO_TESTNET_NETWORK.graphql);
  const archive = readOptionalEnv("ZEKO_ARCHIVE", ZEKO_TESTNET_NETWORK.archive);
  const payerKey = readFirstEnv([
    "X402_PAYER_PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY",
    "MINA_PRIVATE_KEY",
    "WALLET_PRIVATE_KEY"
  ]);
  const zkappPublicKeyBase58 = readOptionalEnv("X402_ZKAPP_PUBLIC_KEY");
  const witnessServiceUrl = readOptionalEnv("X402_WITNESS_SERVICE_URL");
  const settlementStatePath = readOptionalEnv(
    "X402_SETTLEMENT_STATE_PATH",
    path.resolve(__dirname, "../data/settlement-state.json")
  );
  const missing = [];
  const errors = [];

  if (!payerKey) {
    missing.push("X402_PAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY or MINA_PRIVATE_KEY or WALLET_PRIVATE_KEY");
  }

  if (!zkappPublicKeyBase58) {
    missing.push("X402_ZKAPP_PUBLIC_KEY");
  }

  let payerAddress = null;
  if (payerKey) {
    try {
      payerAddress = PrivateKey.fromBase58(payerKey.value).toPublicKey().toBase58();
    } catch (error) {
      missing.push(`${payerKey.name} (invalid Base58 private key)`);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let live = null;
  let witness = null;
  let settlementEvents = null;

  if (zkappPublicKeyBase58) {
    try {
      Mina.setActiveInstance(
        Mina.Network({
          mina: graphql,
          archive
        })
      );

      const zkappAddress = PublicKey.fromBase58(zkappPublicKeyBase58);
      const accountResult = await fetchAccount({ publicKey: zkappAddress });

      if (accountResult.error) {
        errors.push(`x402 settlement zkapp not found at ${zkappPublicKeyBase58}`);
      } else {
        const zkapp = new X402SettlementContract(zkappAddress);
        live = {
          zkappAddress: zkappPublicKeyBase58,
          beneficiary: zkapp.beneficiary.get().toBase58(),
          serviceCommitment: zkapp.serviceCommitment.get().toString(),
          settlementRoot: zkapp.settlementRoot.get().toString()
        };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    try {
      settlementEvents = await fetchSettlementEvents(archive, zkappPublicKeyBase58);
    } catch (error) {
      errors.push(`archive events: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    witness = await readWitnessRoot({
      o1js: await import("o1js"),
      witnessServiceUrl,
      settlementStatePath
    });
  } catch (error) {
    errors.push(`witness state: ${error instanceof Error ? error.message : String(error)}`);
  }

  const alignment =
    live?.settlementRoot && witness?.currentRoot
      ? live.settlementRoot === witness.currentRoot
        ? "aligned"
        : "mismatch"
      : null;

  const ready =
    missing.length === 0 &&
    errors.length === 0 &&
    Boolean(live) &&
    Boolean(witness) &&
    alignment === "aligned";

  let recommendedAction = "Zeko rail is configured for a live smoke run.";

  if (!live) {
    recommendedAction =
      "Deploy a fresh x402 settlement zkApp or point X402_ZKAPP_PUBLIC_KEY at a live deployed contract.";
  } else if (alignment === "mismatch") {
    const mismatchAction =
      live.settlementRoot === EMPTY_SETTLEMENT_ROOT
        ? "Point X402_SETTLEMENT_STATE_PATH or X402_WITNESS_SERVICE_URL at an empty witness store for this contract."
        : settlementEvents && settlementEvents.length > 0
          ? "Rebuild the witness store from onchain settlement events, or point at the matching witness service before running smoke:zeko-flow."
          : "Current zkApp settlementRoot does not match the available witness state. Point at the matching witness store, or deploy a fresh zkApp with a fresh witness store.";
    recommendedAction =
      missing.length > 0
        ? `${mismatchAction} Also set a funded Mina/Zeko payer key before retrying the live smoke flow.`
        : mismatchAction;
  } else if (missing.length > 0) {
    recommendedAction =
      "Set a funded Mina/Zeko payer key plus X402_ZKAPP_PUBLIC_KEY before running the live Zeko smoke flow.";
  } else if (errors.length > 0) {
    recommendedAction =
      "Resolve the reported Zeko network or witness-store errors, then rerun the doctor.";
  }

  return {
    ready,
    graphql,
    archive,
    payerKeySource: payerKey?.name ?? null,
    payerAddress,
    witnessSource: witness?.source ?? (witnessServiceUrl ? "http" : "file"),
    emptySettlementRoot: EMPTY_SETTLEMENT_ROOT,
    live,
    witness,
    alignment,
    settlementEventCount: Array.isArray(settlementEvents) ? settlementEvents.length : null,
    missing,
    errors,
    recommendedAction
  };
}

async function main() {
  const evm = inspectEvm();
  const zeko = await inspectZeko();
  const report = {
    ok: evm.ready && zeko.ready,
    evm,
    zeko
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
