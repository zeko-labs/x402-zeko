import "reflect-metadata";

import path from "node:path";
import { fileURLToPath } from "node:url";

import * as o1js from "o1js";
import { AccountUpdate, UInt64, fetchAccount, Mina, PrivateKey, PublicKey } from "o1js";

import { X402SettlementContract } from "../dist-zkapp/contracts/X402SettlementContract.js";
import {
  InMemorySettlementLedger,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  ZEKO_TESTNET_NETWORK,
  computeSettlementStoreRoot,
  buildCatalog,
  buildDefaultSettlementApplierInput,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSignedZekoZkappAuthorization,
  buildSettlementResponse,
  buildZekoExactSettlementIntent,
  buildZekoSettlementContractRail,
  encodeBase64Json,
  prepareX402SettlementContractCall,
  readSettlementStore,
  recordSettlementWitnessUpdate,
  submitZekoAuthorization,
  verifyPayment,
  waitForZekoTransaction
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function requireEnv(name) {
  const value = readOptionalEnv(name);

  if (!value) {
    throw new Error(`${name} env var is required`);
  }

  return value;
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

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isEmptyPublicKey(publicKey) {
  return Boolean(publicKey?.isEmpty?.()?.toBoolean?.());
}

function readAccountNonce(result) {
  const nonceLike = result?.account?.nonce;

  if (typeof nonceLike?.toBigInt === "function") {
    return nonceLike.toBigInt();
  }

  if (typeof nonceLike?.toString === "function") {
    try {
      return BigInt(nonceLike.toString());
    } catch {
      return null;
    }
  }

  return null;
}

async function waitForSettlementObservation(input) {
  const {
    payerAddress,
    zkappAddress,
    initialPayerNonce,
    initialSettlementRoot,
    attempts,
    pollIntervalMs
  } = input;

  for (let index = 0; index < attempts; index += 1) {
    const payerAccount = await fetchAccount({ publicKey: payerAddress });
    const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
    const payerNonce = readAccountNonce(payerAccount);

    if (!zkappAccount.error) {
      const zkapp = new X402SettlementContract(zkappAddress);
      const settlementRoot = zkapp.settlementRoot.get().toString();

      if (
        (payerNonce !== null && initialPayerNonce !== null && payerNonce > initialPayerNonce) ||
        settlementRoot !== initialSettlementRoot
      ) {
        return {
          accepted: true,
          status: "included",
          payerNonce: payerNonce?.toString() ?? null,
          settlementRoot
        };
      }
    }

    if (index < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return {
    accepted: false,
    status: null,
    payerNonce: initialPayerNonce?.toString() ?? null,
    settlementRoot: initialSettlementRoot
  };
}

function stringifyJsonWithBigInts(value) {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

async function readWitnessRootInfo(input) {
  if (input.witnessServiceUrl) {
    const response = await fetch(`${input.witnessServiceUrl.replace(/\/+$/, "")}/root`);
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

async function main() {
  const graphql = readOptionalEnv("ZEKO_GRAPHQL", ZEKO_TESTNET_NETWORK.graphql);
  const archive = readOptionalEnv("ZEKO_ARCHIVE", ZEKO_TESTNET_NETWORK.archive);
  const payerPrivateKeyBase58 = requireOneOfEnv([
    "X402_PAYER_PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY",
    "MINA_PRIVATE_KEY",
    "WALLET_PRIVATE_KEY"
  ]);
  const zkappPublicKeyBase58 = requireEnv("X402_ZKAPP_PUBLIC_KEY");
  const amountMina = readOptionalEnv("X402_AMOUNT_MINA", "0.015");
  const feeMina = readOptionalEnv("X402_FEE_MINA", "0.10");
  const serviceId = readOptionalEnv("X402_SERVICE_ID", "zeko-x402-smoke");
  const sessionId = readOptionalEnv("X402_SESSION_ID", createId("session"));
  const turnId = readOptionalEnv("X402_TURN_ID", createId("turn"));
  const paymentId = readOptionalEnv("X402_PAYMENT_ID", createId("pay"));
  const baseUrl = readOptionalEnv("X402_BASE_URL", "http://127.0.0.1:7419");
  const proofBundleUrl = readOptionalEnv(
    "X402_PROOF_BUNDLE_URL",
    `${baseUrl}/proof-bundles/${sessionId}.json`
  );
  const verifyUrl = readOptionalEnv("X402_VERIFY_URL", `${baseUrl}/verify/${sessionId}`);
  const witnessServiceUrl = readOptionalEnv("X402_WITNESS_SERVICE_URL");
  const settlementStatePath = readOptionalEnv(
    "X402_SETTLEMENT_STATE_PATH",
    path.resolve(__dirname, "../data/settlement-state.json")
  );
  const waitAttempts = parsePositiveInt(process.env.X402_WAIT_ATTEMPTS, 30);
  const waitIntervalMs = parsePositiveInt(process.env.X402_WAIT_INTERVAL_MS, 5000);

  const payerPrivateKey = PrivateKey.fromBase58(payerPrivateKeyBase58);
  const payerAddress = payerPrivateKey.toPublicKey();
  const zkappAddress = PublicKey.fromBase58(zkappPublicKeyBase58);

  Mina.setActiveInstance(
    Mina.Network({
      mina: graphql,
      archive
    })
  );

  const payerAccount = await fetchAccount({ publicKey: payerAddress });
  const zkappAccount = await fetchAccount({ publicKey: zkappAddress });
  const payerNonce = readAccountNonce(payerAccount);

  if (zkappAccount.error) {
    throw new Error(`x402 settlement zkapp not found at ${zkappAddress.toBase58()}`);
  }

  const zkapp = new X402SettlementContract(zkappAddress);
  const beneficiary = zkapp.beneficiary.get();
  const serviceCommitment = zkapp.serviceCommitment.get();
  const settlementRootBefore = zkapp.settlementRoot.get();
  const witnessRootInfo = await readWitnessRootInfo({
    o1js,
    witnessServiceUrl,
    settlementStatePath
  });

  if (isEmptyPublicKey(beneficiary)) {
    throw new Error("x402 settlement zkapp beneficiary is not configured.");
  }

  if (serviceCommitment.toString() === "0") {
    throw new Error("x402 settlement zkapp serviceCommitment is not configured.");
  }

  if (witnessRootInfo.currentRoot !== settlementRootBefore.toString()) {
    throw new Error(
      [
        "Settlement witness root mismatch.",
        `chain=${settlementRootBefore.toString()}`,
        `witness=${witnessRootInfo.currentRoot}`,
        `source=${witnessRootInfo.source}:${witnessRootInfo.location}`,
        "Point X402_WITNESS_SERVICE_URL or X402_SETTLEMENT_STATE_PATH at the matching witness state, or deploy a fresh zkApp with a fresh witness store."
      ].join(" ")
    );
  }

  await X402SettlementContract.compile();

  const rail = buildZekoSettlementContractRail({
    contractAddress: zkappAddress.toBase58(),
    beneficiaryAddress: beneficiary.toBase58(),
    graphql,
    archive,
    amount: amountMina,
    description: "Zeko x402 smoke-test rail"
  });
  const paymentContext = {
    serviceId,
    sessionId,
    turnId,
    baseUrl,
    proofBundleUrl,
    verifyUrl,
    description: "Smoke-test proof resource negotiated through x402 on Zeko.",
    rails: [rail]
  };
  const catalog = buildCatalog(paymentContext);
  const paymentRequired = buildPaymentRequired(paymentContext);
  const accepted = paymentRequired.accepts.find((entry) => entry.settlementRail === "zeko");

  if (!accepted) {
    throw new Error("Zeko rail was not advertised in the x402 requirement.");
  }

  const unsignedPayload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId,
    option: accepted,
    payer: payerAddress.toBase58(),
    sessionId,
    turnId
  });
  const intent = buildZekoExactSettlementIntent({
    contractAddress: zkappAddress.toBase58(),
    beneficiaryAddress: beneficiary.toBase58(),
    payerAddress: payerAddress.toBase58(),
    requestId: paymentRequired.requestId,
    paymentId,
    paymentContextDigest: unsignedPayload.paymentContextDigest,
    resource: paymentRequired.resource,
    amountMina,
    feeMina
  });
  const preparedSettlement = await prepareX402SettlementContractCall({
    ...buildDefaultSettlementApplierInput({
      ContractClass: X402SettlementContract,
      contractInstance: zkapp,
      serviceCommitment: serviceCommitment.toString(),
      ...(witnessServiceUrl
        ? { witnessServiceUrl }
        : { statePath: settlementStatePath })
    }),
    o1js,
    intent,
    sender: payerAddress,
    feePayer: payerAddress,
    contractAddress: zkappAddress,
    settlementUpdate: intent.accountUpdates[1]
  });
  const transaction = await Mina.transaction(
    {
      sender: payerAddress,
      fee: intent.transaction.feeNanomina,
      memo: intent.transaction.memo,
      ...(payerNonce !== null && payerNonce <= BigInt(Number.MAX_SAFE_INTEGER)
        ? { nonce: Number(payerNonce) }
        : {}),
      ...(typeof intent.transaction.validUntil === "string" && intent.transaction.validUntil.length > 0
        ? { validUntil: intent.transaction.validUntil }
        : {})
    },
    async () => {
      const senderUpdate = AccountUpdate.createSigned(payerAddress);
      senderUpdate.send({
        to: zkappAddress,
        amount: UInt64.from(intent.accountUpdates[0].amountNanomina)
      });
      await preparedSettlement.invoke();
    }
  );

  await transaction.prove();
  transaction.sign([payerPrivateKey]);

  const serializedZkappCommand =
    typeof transaction.toJSON() === "string"
      ? transaction.toJSON()
      : stringifyJsonWithBigInts(transaction.toJSON());

  const authorization = JSON.parse(stringifyJsonWithBigInts(buildSignedZekoZkappAuthorization(intent, {
    zkappCommand: serializedZkappCommand,
    endpoint: graphql,
    settlementWitnessUpdate: preparedSettlement.settlementWitnessUpdate
  })));
  const signedPayload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId,
    option: accepted,
    payer: payerAddress.toBase58(),
    sessionId,
    turnId,
    issuedAtIso: unsignedPayload.issuedAtIso,
    expiresAtIso: unsignedPayload.expiresAtIso,
    paymentContextDigest: unsignedPayload.paymentContextDigest,
    authorization
  });
  const verification = verifyPayment({
    requirements: paymentRequired,
    payload: signedPayload
  });

  if (!verification.ok) {
    throw new Error(verification.reason ?? "Payment payload failed x402 verification.");
  }

  const submission = await submitZekoAuthorization(authorization);

  if (!submission.hash) {
    throw new Error("sendZkapp did not return a transaction hash.");
  }

  let status = await waitForZekoTransaction(submission.hash, {
    endpoint: graphql,
    attempts: waitAttempts,
    pollIntervalMs: waitIntervalMs
  });

  if (
    !status.accepted &&
    Array.isArray(status.attempts) &&
    status.attempts.every((attempt) => attempt.ok === false)
  ) {
    status = await waitForSettlementObservation({
      payerAddress,
      zkappAddress,
      initialPayerNonce: payerNonce,
      initialSettlementRoot: settlementRootBefore.toString(),
      attempts: waitAttempts,
      pollIntervalMs: waitIntervalMs
    });
  }

  if (!status.accepted) {
    throw new Error(`Transaction ${submission.hash} was not observed before timeout.`);
  }

  if (!authorization.settlementWitnessUpdate) {
    throw new Error("Signed authorization did not include a settlementWitnessUpdate.");
  }

  await recordSettlementWitnessUpdate(
    witnessServiceUrl || settlementStatePath,
    authorization.settlementWitnessUpdate,
    {
      requestId: paymentRequired.requestId,
      paymentId,
      txHash: submission.hash
    }
  );

  const ledger = new InMemorySettlementLedger({
    sponsoredBudget: readOptionalEnv("X402_SPONSORED_BUDGET_MINA", "1.0"),
    budgetAsset: accepted.asset
  });
  const settlement = ledger.settle({
    ...signedPayload,
    resource: paymentRequired.resource,
    settlementReference: submission.hash
  });
  const paymentResponse = buildSettlementResponse({
    payload: signedPayload,
    duplicate: settlement.duplicate,
    eventIds: settlement.settlement.eventIds,
    settledAtIso: settlement.settlement.settledAtIso,
    remainingBudget: settlement.remainingBudget,
    sponsoredBudget: settlement.sponsoredBudget,
    budgetAsset: settlement.budgetAsset,
    proofBundleUrl,
    verifyUrl,
    settlementModel: accepted.settlementModel,
    settlementReference: submission.hash,
    zeko: {
      graphql,
      archive,
      networkId: accepted.network,
      contractAddress: zkappAddress.toBase58(),
      beneficiaryAddress: beneficiary.toBase58(),
      settlementRootBefore: settlementRootBefore.toString()
    }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        network: {
          graphql,
          archive,
          explorer: ZEKO_TESTNET_NETWORK.explorer
        },
        contract: {
          zkappAddress: zkappAddress.toBase58(),
          beneficiary: beneficiary.toBase58(),
          serviceCommitment: serviceCommitment.toString(),
          settlementRootBefore: settlementRootBefore.toString()
        },
        payment: {
          requestId: paymentRequired.requestId,
          paymentId,
          option: accepted,
          verification,
          submission,
          status
        },
        headers: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodeBase64Json(paymentRequired),
          [X402_PAYMENT_SIGNATURE_HEADER]: encodeBase64Json(signedPayload),
          [X402_PAYMENT_RESPONSE_HEADER]: encodeBase64Json(paymentResponse)
        },
        catalog,
        paymentRequired,
        paymentPayload: signedPayload,
        paymentResponse,
        resource: {
          ok: true,
          sessionId,
          turnId,
          proofBundleUrl,
          verifyUrl,
          txHash: submission.hash
        },
        witness: {
          target: witnessServiceUrl || settlementStatePath,
          settlementWitnessUpdate: authorization.settlementWitnessUpdate
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[zeko-x402:smoke-zeko-flow] failed", error);
  process.exit(1);
});
