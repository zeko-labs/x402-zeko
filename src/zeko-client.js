import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { buildSignedZekoZkappAuthorization } from "./payments.js";
import {
  buildDefaultSettlementApplierInput,
  createX402SettlementMethodApplier,
  prepareX402SettlementContractCall
} from "./zeko-settlement-contract.js";

const CONTRACT_COMPILE_CACHE = new WeakMap();
const REQUIRE = createRequire(import.meta.url);

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function getFetch(fetchImpl) {
  const resolved = fetchImpl ?? globalThis.fetch;

  if (typeof resolved !== "function") {
    throw new Error("fetch implementation is required.");
  }

  return resolved;
}

function getFetchAccount(o1js) {
  const fetchAccount = o1js?.fetchAccount ?? o1js?.Mina?.fetchAccount;

  if (typeof fetchAccount !== "function") {
    throw new Error("o1js fetchAccount is required.");
  }

  return fetchAccount;
}

function getGraphqlSubmission(authorization) {
  if (authorization?.submission?.kind === "graphql") {
    return authorization.submission;
  }

  if (authorization?.graphql) {
    return authorization.graphql;
  }

  throw new Error("Zeko authorization does not contain a GraphQL submission payload.");
}

async function loadO1js(loadO1jsModule) {
  if (typeof loadO1jsModule === "function") {
    return await loadO1jsModule();
  }

  try {
    const nodeEntry = REQUIRE.resolve("o1js").replace(/index\.cjs$/, "index.js");
    return await import(pathToFileURL(nodeEntry).href);
  } catch (nodeEntryError) {
    try {
      return await import("o1js");
    } catch (importError) {
      const message = importError instanceof Error
        ? importError.message
        : nodeEntryError instanceof Error
          ? nodeEntryError.message
          : "o1js could not be loaded.";

      throw new Error(`o1js is required for Zeko settlement signing: ${message}`);
    }
  }
}

async function ensureContractCompiled(ContractClass) {
  if (typeof ContractClass?.compile !== "function") {
    return;
  }

  let compilePromise = CONTRACT_COMPILE_CACHE.get(ContractClass);

  if (!compilePromise) {
    compilePromise = Promise.resolve().then(() => ContractClass.compile());
    CONTRACT_COMPILE_CACHE.set(ContractClass, compilePromise);
  }

  try {
    await compilePromise;
  } catch (error) {
    if (CONTRACT_COMPILE_CACHE.get(ContractClass) === compilePromise) {
      CONTRACT_COMPILE_CACHE.delete(ContractClass);
    }

    throw error;
  }
}

function summarizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

const ZEKO_TX_STATUS_VARIANTS = [
  {
    name: "transactionStatus(zkappTransaction)",
    query: "query($hash:String!){ transactionStatus(zkappTransaction:$hash) }",
    extract(data) {
      return typeof data?.transactionStatus === "string"
        ? {
            found: true,
            status: data.transactionStatus,
            transaction: null
          }
        : null;
    }
  },
  {
    name: "transaction(hash)",
    query:
      "query($hash:String!){ transaction(hash:$hash){ hash from to amount token memo fee blockHeight dateTime canonical } }",
    extract(data) {
      return data?.transaction && typeof data.transaction === "object"
        ? {
            found: true,
            status: data.transaction.canonical === true ? "included" : null,
            transaction: data.transaction
          }
        : null;
    }
  },
  {
    name: "transactionStatus(payment)",
    query:
      "query($hash:String!){ transactionStatus(payment:$hash){ hash from to amount token memo fee blockHeight dateTime status } }",
    extract(data) {
      return data?.transactionStatus && typeof data.transactionStatus === "object"
        ? {
            found: true,
            status:
              typeof data.transactionStatus.status === "string" ? data.transactionStatus.status : null,
            transaction: data.transactionStatus
          }
        : null;
    }
  }
];

function normalizeStatus(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function graphqlRequest(input) {
  const fetchImpl = getFetch(input?.fetchImpl);
  const endpoint = assertNonEmptyString("endpoint", input?.endpoint);
  const query = assertNonEmptyString("query", input?.query);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input?.headers ?? {})
    },
    body: JSON.stringify({
      query,
      ...(input?.variables ? { variables: input.variables } : {})
    })
  });
  const json = await response.json();

  if (!response.ok) {
    throw new Error(`GraphQL request failed (${response.status}).`);
  }

  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(json.errors.map((entry) => entry?.message ?? String(entry)).join("; "));
  }

  return json?.data ?? {};
}

export async function submitZekoAuthorization(authorization, input = {}) {
  const submission = getGraphqlSubmission(authorization);
  const data = await graphqlRequest({
    endpoint: submission.endpoint,
    query: submission.query,
    variables: submission.variables,
    fetchImpl: input.fetchImpl,
    headers: input.headers
  });

  const payment = data?.sendPayment?.payment;

  if (payment) {
    return {
      primitive: authorization.primitive,
      settlementRail: "zeko",
      kind: "payment",
      hash: payment.hash ?? null,
      payment,
      data
    };
  }

  const zkapp = data?.sendZkapp?.zkapp;

  if (zkapp) {
    const failures = zkapp?.failureReason?.failures;

    if (Array.isArray(failures) && failures.length > 0) {
      throw new Error(`sendZkapp failed: ${JSON.stringify(failures)}`);
    }

    return {
      primitive: authorization.primitive,
      settlementRail: "zeko",
      kind: "zkapp",
      hash: zkapp.hash ?? null,
      id: zkapp.id ?? null,
      zkapp,
      data
    };
  }

  return {
    primitive: authorization.primitive,
    settlementRail: "zeko",
    kind: "unknown",
    data
  };
}

export async function fetchZekoTransactionStatus(hash, input = {}) {
  const endpoint = assertNonEmptyString("endpoint", input?.endpoint);
  const attempts = [];

  for (const variant of ZEKO_TX_STATUS_VARIANTS) {
    try {
      const data = await graphqlRequest({
        endpoint,
        query: variant.query,
        variables: { hash },
        fetchImpl: input.fetchImpl,
        headers: input.headers
      });
      const match = variant.extract(data);

      attempts.push({
        variant: variant.name,
        ok: true,
        found: Boolean(match?.found)
      });

      if (match?.found) {
        return {
          ok: true,
          found: true,
          hash,
          endpoint,
          variant: variant.name,
          status: match.status ?? null,
          transaction: match.transaction ?? null,
          attempts
        };
      }
    } catch (error) {
      attempts.push({
        variant: variant.name,
        ok: false,
        error: summarizeError(error)
      });
    }
  }

  return {
    ok: false,
    found: false,
    hash,
    endpoint,
    status: null,
    transaction: null,
    attempts
  };
}

export async function waitForZekoTransaction(hash, input = {}) {
  const attempts = Math.max(1, Number(input?.attempts ?? 30));
  const pollIntervalMs = Math.max(250, Number(input?.pollIntervalMs ?? 3000));
  const okStatuses = new Set(
    (input?.okStatuses ?? ["included", "applied", "pending"]).map((entry) => normalizeStatus(entry))
  );
  const failedStatuses = new Set(
    (input?.failedStatuses ?? ["rejected", "failed", "expired"]).map((entry) => normalizeStatus(entry))
  );
  let last = null;

  for (let index = 0; index < attempts; index += 1) {
    last = await fetchZekoTransactionStatus(hash, input);
    const normalizedStatus = normalizeStatus(last.status);

    if (last.found && (normalizedStatus.length === 0 || okStatuses.has(normalizedStatus))) {
      return {
        ...last,
        accepted: true
      };
    }

    if (failedStatuses.has(normalizedStatus)) {
      throw new Error(
        `Zeko transaction ${hash} reached terminal status ${last.status ?? "unknown"} on ${last.variant ?? "unknown"}`
      );
    }

    if (index < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return {
    ...(last ?? {
      ok: false,
      found: false,
      hash,
      endpoint: input?.endpoint ?? null,
      status: null,
      transaction: null,
      attempts: []
    }),
    accepted: false
  };
}

export async function prepareSignedZekoSettlementAuthorization(intent, input) {
  const settlementContractInput =
    input?.settlementContract &&
    typeof input.settlementContract === "object" &&
    input.settlementContract !== null
      ? buildDefaultSettlementApplierInput(input.settlementContract)
      : null;
  const applyContractCall =
    typeof input?.applyContractCall === "function"
      ? input.applyContractCall
      : settlementContractInput
        ? createX402SettlementMethodApplier(settlementContractInput)
        : null;

  if (typeof applyContractCall !== "function") {
    throw new Error(
      "applyContractCall is required unless settlementContract.{ContractClass|createContract,witnessProvider|inMemoryWitnessState} is provided."
    );
  }

  const o1js = await loadO1js(input?.loadO1js);
  const { AccountUpdate, Mina, PrivateKey, PublicKey, UInt64 } = o1js;

  if (!AccountUpdate || !Mina || !PrivateKey || !PublicKey || !UInt64) {
    throw new Error("o1js module does not expose the required Zeko transaction primitives.");
  }

  const senderKey = PrivateKey.fromBase58(assertNonEmptyString("senderPrivateKey", input?.senderPrivateKey));
  const sender = senderKey.toPublicKey();
  const feePayerKey = input?.feePayerPrivateKey
    ? PrivateKey.fromBase58(assertNonEmptyString("feePayerPrivateKey", input.feePayerPrivateKey))
    : senderKey;
  const feePayer = feePayerKey.toPublicKey();
  const transferUpdate = intent?.accountUpdates?.[0];
  const settlementUpdate = intent?.accountUpdates?.[1];

  if (!transferUpdate || !settlementUpdate) {
    throw new Error("Zeko settlement intent must include transfer and settlement account updates.");
  }

  if (input?.prove !== false && settlementContractInput?.ContractClass) {
    await ensureContractCompiled(settlementContractInput.ContractClass);
  }

  const contractAddress = PublicKey.fromBase58(
    assertNonEmptyString("contractAddress", settlementUpdate.contractAddress)
  );
  const activeNetwork = Mina.Network({
    networkId: intent?.network?.o1jsNetworkId ?? "zeko",
    mina: assertNonEmptyString("graphql", intent?.network?.graphql),
    archive: intent?.network?.archive
  });
  Mina.setActiveInstance(activeNetwork);

  const fetchAccount = getFetchAccount(o1js);
  await fetchAccount({ publicKey: sender });
  await fetchAccount({ publicKey: contractAddress });

  let settlementWitnessUpdate = null;
  const preparedSettlementContractCall =
    settlementContractInput && typeof input?.applyContractCall !== "function"
      ? await prepareX402SettlementContractCall({
          ...settlementContractInput,
          o1js,
          intent,
          sender,
          feePayer,
          contractAddress,
          settlementUpdate
        })
      : null;

  const transaction = await Mina.transaction(
    {
      sender: feePayer,
      fee: intent.transaction.feeNanomina,
      memo: intent.transaction.memo,
      ...(input?.nonce !== undefined ? { nonce: input.nonce } : {}),
      ...(typeof intent.transaction.validUntil === "string" && intent.transaction.validUntil.length > 0
        ? { validUntil: intent.transaction.validUntil }
        : {})
    },
    async () => {
      const senderUpdate = AccountUpdate.createSigned(sender);
      senderUpdate.send({
        to: contractAddress,
        amount: UInt64.from(transferUpdate.amountNanomina)
      });
      if (preparedSettlementContractCall) {
        await preparedSettlementContractCall.invoke();
        settlementWitnessUpdate = preparedSettlementContractCall.settlementWitnessUpdate;
      } else {
        settlementWitnessUpdate = await applyContractCall({
          o1js,
          intent,
          sender,
          feePayer,
          contractAddress,
          settlementUpdate
        });
      }
    }
  );

  if (input?.prove !== false && typeof transaction.prove === "function") {
    await transaction.prove();
  }

  const extraSignerKeys = Array.isArray(input?.extraPrivateKeys)
    ? input.extraPrivateKeys.map((value) => PrivateKey.fromBase58(assertNonEmptyString("extraPrivateKeys[]", value)))
    : [];
  const signerKeys = feePayerKey === senderKey
    ? [feePayerKey, ...extraSignerKeys]
    : [feePayerKey, senderKey, ...extraSignerKeys];

  if (typeof transaction.sign === "function") {
    transaction.sign(signerKeys);
  }

  if (typeof transaction.toJSON !== "function") {
    throw new Error("Signed Zeko settlement transaction could not be serialized to JSON.");
  }

  return buildSignedZekoZkappAuthorization(intent, {
    zkappCommand: transaction.toJSON(),
    endpoint: input?.endpoint ?? intent?.network?.graphql,
    ...(settlementWitnessUpdate ? { settlementWitnessUpdate } : {})
  });
}

export async function signAndSubmitZekoSettlement(intent, input) {
  const authorization = await prepareSignedZekoSettlementAuthorization(intent, input);
  const submission = await submitZekoAuthorization(authorization, input);

  return {
    authorization,
    submission
  };
}
