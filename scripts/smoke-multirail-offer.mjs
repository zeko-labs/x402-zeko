import "reflect-metadata";

import { Mina, PublicKey, fetchAccount } from "o1js";

import { X402SettlementContract } from "../dist-zkapp/contracts/X402SettlementContract.js";
import {
  X402_PAYMENT_REQUIRED_HEADER,
  buildBaseMainnetUsdcRail,
  buildCatalog,
  buildEthereumMainnetUsdcRail,
  buildPaymentRequired,
  buildZekoSettlementContractRail,
  encodeBase64Json
} from "../src/index.js";
import { ZEKO_TESTNET_NETWORK } from "../src/targets.js";

function readOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}`;
}

function isExplicitlyFalse(value) {
  return /^(0|false|no)$/i.test(String(value ?? "").trim());
}

function resolveBasePayTo() {
  return readOptionalEnv(
    "X402_BASE_PAY_TO",
    readOptionalEnv(
      "X402_EVM_PAY_TO",
      readOptionalEnv("X402_BASE_TREASURY_ADDRESS", readOptionalEnv("X402_EVM_TREASURY_ADDRESS"))
    )
  );
}

function resolveEthereumPayTo(basePayTo) {
  return readOptionalEnv(
    "X402_ETHEREUM_PAY_TO",
    readOptionalEnv(
      "X402_EVM_PAY_TO",
      readOptionalEnv(
        "X402_ETHEREUM_TREASURY_ADDRESS",
        readOptionalEnv("X402_EVM_TREASURY_ADDRESS", basePayTo)
      )
    )
  );
}

async function resolveZekoBeneficiary(zkappPublicKeyBase58) {
  const graphql = readOptionalEnv("ZEKO_GRAPHQL", ZEKO_TESTNET_NETWORK.graphql);
  const archive = readOptionalEnv("ZEKO_ARCHIVE", ZEKO_TESTNET_NETWORK.archive);
  const explicitBeneficiary =
    readOptionalEnv("X402_ZEKO_BENEFICIARY_PUBLIC_KEY") ||
    readOptionalEnv("X402_BENEFICIARY_PUBLIC_KEY");

  if (explicitBeneficiary) {
    return {
      beneficiary: explicitBeneficiary,
      graphql,
      archive
    };
  }

  Mina.setActiveInstance(
    Mina.Network({
      networkId: ZEKO_TESTNET_NETWORK.o1jsNetworkId,
      mina: graphql,
      archive
    })
  );

  const zkappAddress = PublicKey.fromBase58(zkappPublicKeyBase58);
  const result = await fetchAccount({ publicKey: zkappAddress });

  if (result.error) {
    throw new Error(`Unable to fetch Zeko settlement contract at ${zkappPublicKeyBase58}.`);
  }

  const zkapp = new X402SettlementContract(zkappAddress);
  return {
    beneficiary: zkapp.beneficiary.get().toBase58(),
    graphql,
    archive
  };
}

async function main() {
  const serviceId = readOptionalEnv("X402_SERVICE_ID", "zeko-x402-multirail");
  const sessionId = readOptionalEnv("X402_SESSION_ID", createId("session"));
  const turnId = readOptionalEnv("X402_TURN_ID", createId("turn"));
  const baseUrl = readOptionalEnv("X402_BASE_URL", "http://127.0.0.1:7422");
  const proofBundleUrl = readOptionalEnv(
    "X402_PROOF_BUNDLE_URL",
    `${baseUrl}/proof-bundles/${sessionId}.json`
  );
  const verifyUrl = readOptionalEnv("X402_VERIFY_URL", `${baseUrl}/verify/${sessionId}`);
  const rails = [];
  const advertisedRails = [];

  const evmPayTo = resolveBasePayTo();
  const baseAmount = readOptionalEnv("X402_BASE_USDC_AMOUNT", readOptionalEnv("X402_EVM_AMOUNT", "0.50"));

  if (evmPayTo && !isExplicitlyFalse(readOptionalEnv("X402_INCLUDE_BASE", "true"))) {
    rails.push(
      buildBaseMainnetUsdcRail({
        payTo: evmPayTo,
        amount: baseAmount
      })
    );
    advertisedRails.push("base");
  }

  const includeEthereum = !isExplicitlyFalse(readOptionalEnv("X402_INCLUDE_ETHEREUM", "false"));
  const ethereumPayTo = resolveEthereumPayTo(evmPayTo);
  if (includeEthereum && ethereumPayTo) {
    rails.push(
      buildEthereumMainnetUsdcRail({
        payTo: ethereumPayTo,
        amount: readOptionalEnv("X402_ETHEREUM_USDC_AMOUNT", baseAmount)
      })
    );
    advertisedRails.push("ethereum");
  }

  const zekoZkapp = readOptionalEnv("X402_ZKAPP_PUBLIC_KEY");
  if (zekoZkapp && !isExplicitlyFalse(readOptionalEnv("X402_INCLUDE_ZEKO", "true"))) {
    const { beneficiary, graphql, archive } = await resolveZekoBeneficiary(zekoZkapp);
    rails.push(
      buildZekoSettlementContractRail({
        contractAddress: zekoZkapp,
        beneficiaryAddress: beneficiary,
        graphql,
        archive,
        amount: readOptionalEnv("X402_ZEKO_AMOUNT_MINA", "0.015"),
        description: "Zeko zkApp settlement rail for verified-result and privacy-forward payment flows."
      })
    );
    advertisedRails.push("zeko");
  }

  if (rails.length === 0) {
    throw new Error(
      "No rails configured. Set an EVM payTo address and/or X402_ZKAPP_PUBLIC_KEY before running the multi-rail offer."
    );
  }

  const paymentContext = {
    serviceId,
    sessionId,
    turnId,
    baseUrl,
    proofBundleUrl,
    verifyUrl,
    description:
      "Multi-rail proof resource that advertises default x402 EVM payment options alongside a Zeko-native zkApp settlement rail.",
    rails
  };
  const catalog = buildCatalog(paymentContext);
  const paymentRequired = buildPaymentRequired(paymentContext);

  console.log(
    JSON.stringify(
      {
        ok: true,
        advertisedRails,
        catalog,
        paymentRequired,
        headers: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodeBase64Json(paymentRequired)
        },
        resource: {
          ok: false,
          status: 402,
          sessionId,
          turnId,
          proofBundleUrl,
          verifyUrl
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[zeko-x402:smoke-multirail-offer] failed", error);
  process.exit(1);
});
