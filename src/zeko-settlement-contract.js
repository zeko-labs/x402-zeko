import {
  createFileBackedSettlementWitnessProvider,
  createHttpSettlementWitnessProvider
} from "./settlement-store.js";

const UTF8_ENCODER = new TextEncoder();

export const X402_SETTLEMENT_METHOD = "settleExact";

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldLike(value) {
  return value !== null && value !== undefined && typeof value.toString === "function";
}

function toField(o1js, value) {
  return o1js.Field(value.toString());
}

function normalizeHex(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^0x/i, "")
    .toLowerCase();

  return /^[0-9a-f]+$/.test(normalized) ? normalized : null;
}

function bytesToFields(o1js, bytes) {
  const { Field } = o1js;
  const fields = [];

  for (let offset = 0; offset < bytes.length; offset += 31) {
    const chunk = bytes.slice(offset, offset + 31);
    let value = 0n;

    for (const entry of chunk) {
      value = (value << 8n) + BigInt(entry);
    }

    fields.push(Field(value));
  }

  return fields.length > 0 ? fields : [Field(0)];
}

function textToFields(o1js, value) {
  return bytesToFields(o1js, UTF8_ENCODER.encode(String(value ?? "")));
}

function hexToBytes(value) {
  const normalized = normalizeHex(value);

  if (!normalized) {
    return null;
  }

  const evenLength = normalized.length % 2 === 0 ? normalized : `0${normalized}`;
  return Uint8Array.from(evenLength.match(/.{1,2}/g) ?? [], (entry) => parseInt(entry, 16));
}

export function hashTextToField(o1js, value) {
  const { Poseidon } = o1js;
  return Poseidon.hash(textToFields(o1js, value));
}

export function hashDigestToField(o1js, value) {
  const { Poseidon } = o1js;
  const bytes = hexToBytes(value);
  return Poseidon.hash(bytes ? bytesToFields(o1js, bytes) : textToFields(o1js, value));
}

export function buildSettlementCallArguments(o1js, input) {
  const { Poseidon, PublicKey, UInt64 } = o1js;
  const requestIdHash = hashTextToField(o1js, assertNonEmptyString("requestId", input?.requestId));
  const paymentIdHash = hashTextToField(o1js, assertNonEmptyString("paymentId", input?.paymentId));
  const payer = PublicKey.fromBase58(assertNonEmptyString("payerAddress", input?.payerAddress));
  const beneficiary = PublicKey.fromBase58(assertNonEmptyString("beneficiaryAddress", input?.beneficiaryAddress));
  const amountNanomina = UInt64.from(assertNonEmptyString("amountNanomina", input?.amountNanomina));
  const paymentContextDigest = hashDigestToField(
    o1js,
    assertNonEmptyString("paymentContextDigest", input?.paymentContextDigest)
  );
  const resourceDigest = hashDigestToField(
    o1js,
    assertNonEmptyString("resourceDigest", input?.resourceDigest)
  );
  const paymentKey = Poseidon.hash([requestIdHash, paymentIdHash]);

  return {
    requestIdHash,
    paymentIdHash,
    payer,
    beneficiary,
    amountNanomina,
    paymentContextDigest,
    resourceDigest,
    paymentKey
  };
}

export function buildSettlementLeaf(o1js, input) {
  const { Poseidon } = o1js;
  return Poseidon.hash([
    input.requestIdHash,
    input.paymentIdHash,
    ...input.payer.toFields(),
    ...input.beneficiary.toFields(),
    input.amountNanomina.value ?? input.amountNanomina,
    input.paymentContextDigest,
    input.resourceDigest,
    input.serviceCommitment
  ]);
}

export function createInMemorySettlementWitnessProvider(input = {}) {
  const entries = new Map(
    Array.isArray(input.entries)
      ? input.entries.map((entry) => [String(entry.key), String(entry.value)])
      : []
  );

  return async function provideWitness(context) {
    const { Field, MerkleMap } = context.o1js;
    const map = new MerkleMap();

    for (const [key, value] of entries) {
      map.set(Field(key), Field(value));
    }

    const witness = map.getWitness(context.paymentKey);
    return {
      witness,
      currentRoot: map.getRoot(),
      markSettled() {
        entries.set(String(context.paymentKey), String(context.paymentLeaf));
      }
    };
  };
}

function resolveContract(input, o1js, contractAddress) {
  if (typeof input?.createContract === "function") {
    return input.createContract({
      o1js,
      contractAddress,
      publicKey: o1js.PublicKey.fromBase58(contractAddress)
    });
  }

  if (input?.contractInstance) {
    return input.contractInstance;
  }

  if (typeof input?.ContractClass === "function") {
    return new input.ContractClass(o1js.PublicKey.fromBase58(contractAddress));
  }

  throw new Error("A settlement contract instance, constructor, or createContract callback is required.");
}

function resolveServiceCommitmentField(input, contract) {
  if (isFieldLike(input?.serviceCommitmentField)) {
    return toField(input.o1js, input.serviceCommitmentField);
  }

  if (isFieldLike(input?.serviceCommitment)) {
    return toField(input.o1js, input.serviceCommitment);
  }

  const contractServiceCommitment = contract?.serviceCommitment?.get?.();
  if (isFieldLike(contractServiceCommitment) && contractServiceCommitment.toString() !== "0") {
    return toField(input.o1js, contractServiceCommitment);
  }

  return hashDigestToField(
    input.o1js,
    input.serviceCommitment ??
      input.intent?.resourceDigest ??
      input.settlementUpdate?.args?.resourceDigest ??
      input.intent?.settlementVerification?.eventType ??
      "x402-settlement-service"
  );
}

async function resolveWitness(input, context) {
  if (typeof input?.witnessProvider === "function") {
    return await input.witnessProvider(context);
  }

  if (input?.paymentWitness) {
    return {
      witness: input.paymentWitness,
      currentRoot: input.currentRoot ?? null,
      markSettled: typeof input.markSettled === "function" ? input.markSettled : undefined
    };
  }

  throw new Error("A payment witness or witnessProvider is required for Zeko exact settlement.");
}

export function createX402SettlementMethodApplier(input = {}) {
  const methodName = input.methodName ?? X402_SETTLEMENT_METHOD;

  return async function applyX402SettlementContractCall(context) {
    const prepared = await prepareX402SettlementContractCall({
      ...input,
      ...context,
      methodName
    });

    await prepared.invoke();
    return prepared.settlementWitnessUpdate;
  };
}

export async function prepareX402SettlementContractCall(input = {}) {
  const methodName = input.methodName ?? X402_SETTLEMENT_METHOD;
  const contract = resolveContract(input, input.o1js, input.contractAddress.toBase58());
  const serviceCommitment = resolveServiceCommitmentField(input, contract);
  const callArgs = buildSettlementCallArguments(input.o1js, input.settlementUpdate?.args ?? {});
  const paymentLeaf = buildSettlementLeaf(input.o1js, {
    ...callArgs,
    serviceCommitment
  });
  const witnessInfo = await resolveWitness(input, {
    ...input,
    ...callArgs,
      paymentLeaf,
      serviceCommitment
    });
  const witness = witnessInfo?.witness ?? witnessInfo;

  if (!witness) {
    throw new Error("Witness provider did not return a witness.");
  }

  if (typeof contract?.[methodName] !== "function") {
    throw new Error(`Settlement contract does not expose ${methodName}(...).`);
  }

  return {
    methodName,
    settlementWitnessUpdate: {
      methodName,
      paymentKey: callArgs.paymentKey.toString(),
      paymentLeaf: paymentLeaf.toString(),
      serviceCommitment: serviceCommitment.toString(),
      currentRoot: witnessInfo?.currentRoot ?? null
    },
    async invoke() {
      await contract[methodName](
      callArgs.requestIdHash,
      callArgs.paymentIdHash,
      callArgs.payer,
      callArgs.beneficiary,
      callArgs.amountNanomina,
      callArgs.paymentContextDigest,
      callArgs.resourceDigest,
      witness
      );
    }
  };
}

export function buildDefaultSettlementApplierInput(input) {
  if (!isRecord(input)) {
    throw new Error("Settlement contract configuration must be an object.");
  }

  return {
    ...input,
    witnessProvider:
      input.witnessProvider ??
      (typeof input.witnessServiceUrl === "string" && input.witnessServiceUrl.length > 0
        ? createHttpSettlementWitnessProvider({
            baseUrl: input.witnessServiceUrl,
            headers: input.witnessServiceHeaders
          })
        : typeof input.statePath === "string" && input.statePath.length > 0
          ? createFileBackedSettlementWitnessProvider({
              statePath: input.statePath
            })
          : createInMemorySettlementWitnessProvider(input.inMemoryWitnessState ?? {}))
  };
}
