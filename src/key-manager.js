import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";

import { PrivateKey as MinaPrivateKey } from "o1js";
import { privateKeyToAccount } from "viem/accounts";

export const KEYRING_FORMAT = "zeko-x402-keyring";
export const KEYRING_VERSION = 1;

export function defaultKeyringPath(cwd = process.cwd()) {
  return path.resolve(cwd, ".keys", "zeko-x402.keys.json");
}

function nowIso() {
  return new Date().toISOString();
}

function assertNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function normalizeEvmPrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function deriveKey(passphrase, saltHex) {
  return scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32);
}

function encryptSecret(secret, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt.toString("hex"));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: "aes-256-gcm",
    saltHex: salt.toString("hex"),
    ivHex: iv.toString("hex"),
    authTagHex: authTag.toString("hex"),
    ciphertextHex: ciphertext.toString("hex")
  };
}

function decryptSecret(record, passphrase) {
  const key = deriveKey(passphrase, record.saltHex);
  const decipher = createDecipheriv(
    record.algorithm ?? "aes-256-gcm",
    key,
    Buffer.from(record.ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(record.authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertextHex, "hex")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export function createEmptyKeyring() {
  return {
    format: KEYRING_FORMAT,
    version: KEYRING_VERSION,
    createdAtIso: nowIso(),
    updatedAtIso: nowIso(),
    entries: {}
  };
}

export async function readKeyring(filePath, { create = false } = {}) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed?.format !== KEYRING_FORMAT || parsed?.version !== KEYRING_VERSION || !parsed?.entries) {
      throw new Error("Invalid zeko-x402 keyring format.");
    }

    return parsed;
  } catch (error) {
    if (create && error && typeof error === "object" && error.code === "ENOENT") {
      const empty = createEmptyKeyring();
      await writeKeyring(filePath, empty);
      return empty;
    }

    throw error;
  }
}

export async function writeKeyring(filePath, keyring) {
  await ensureParentDir(filePath);
  await writeFile(filePath, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
}

export function generateEvmKey() {
  const privateKey = `0x${randomBytes(32).toString("hex")}`;
  const account = privateKeyToAccount(privateKey);
  return {
    type: "evm",
    privateKey,
    address: account.address
  };
}

export function generateMinaKey() {
  const privateKey = MinaPrivateKey.random();
  return {
    type: "mina",
    privateKey: privateKey.toBase58(),
    address: privateKey.toPublicKey().toBase58()
  };
}

export async function storeManagedKey(input) {
  const filePath = input.filePath ?? defaultKeyringPath();
  const passphrase = assertNonEmpty("passphrase", input.passphrase);
  const name = assertNonEmpty("name", input.name);
  const kind = assertNonEmpty("kind", input.kind);
  const privateKey = assertNonEmpty("privateKey", input.privateKey);
  const address = assertNonEmpty("address", input.address);
  const keyring = await readKeyring(filePath, { create: true });

  keyring.entries[name] = {
    name,
    kind,
    address,
    createdAtIso: keyring.entries[name]?.createdAtIso ?? nowIso(),
    updatedAtIso: nowIso(),
    encryptedPrivateKey: encryptSecret(privateKey, passphrase),
    metadata: input.metadata ?? {}
  };
  keyring.updatedAtIso = nowIso();

  await writeKeyring(filePath, keyring);
  return keyring.entries[name];
}

export async function listManagedKeys(filePath = defaultKeyringPath()) {
  const keyring = await readKeyring(filePath, { create: true });
  return Object.values(keyring.entries).map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    address: entry.address,
    createdAtIso: entry.createdAtIso,
    updatedAtIso: entry.updatedAtIso,
    metadata: entry.metadata ?? {}
  }));
}

export async function readManagedKey(input) {
  const filePath = input.filePath ?? defaultKeyringPath();
  const passphrase = assertNonEmpty("passphrase", input.passphrase);
  const name = assertNonEmpty("name", input.name);
  const keyring = await readKeyring(filePath, { create: false });
  const entry = keyring.entries[name];

  if (!entry) {
    throw new Error(`Managed key "${name}" was not found.`);
  }

  return {
    ...entry,
    privateKey: decryptSecret(entry.encryptedPrivateKey, passphrase)
  };
}

export function buildEnvExport(role, entry) {
  const normalizedRole = assertNonEmpty("role", role).toLowerCase();

  if (normalizedRole === "buyer" && entry.kind === "evm") {
    return {
      X402_EVM_PRIVATE_KEY: entry.privateKey,
      X402_EVM_BUYER_ADDRESS: entry.address
    };
  }

  if (normalizedRole === "relayer" && entry.kind === "evm") {
    return {
      X402_EVM_RELAYER_PRIVATE_KEY: entry.privateKey,
      X402_EVM_RELAYER_ADDRESS: entry.address
    };
  }

  if (normalizedRole === "payto" && entry.kind === "evm") {
    return {
      X402_EVM_PAY_TO: entry.address,
      X402_BASE_PAY_TO: entry.address,
      X402_ETHEREUM_PAY_TO: entry.address,
      X402_EVM_PAY_TO_ADDRESS: entry.address
    };
  }

  if (normalizedRole === "zeko-payer" && entry.kind === "mina") {
    return {
      X402_PAYER_PRIVATE_KEY: entry.privateKey,
      X402_PAYER_PUBLIC_KEY: entry.address
    };
  }

  if (normalizedRole === "zeko-beneficiary" && entry.kind === "mina") {
    return {
      X402_ZEKO_BENEFICIARY_PUBLIC_KEY: entry.address
    };
  }

  throw new Error(`Unsupported export role "${role}" for key kind "${entry.kind}".`);
}

export function formatEnvExport(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function importManagedKey(input) {
  const kind = assertNonEmpty("kind", input.kind).toLowerCase();

  if (kind === "evm") {
    const privateKey = normalizeEvmPrivateKey(assertNonEmpty("privateKey", input.privateKey));
    const account = privateKeyToAccount(privateKey);
    return {
      kind,
      privateKey,
      address: account.address
    };
  }

  if (kind === "mina") {
    const privateKey = assertNonEmpty("privateKey", input.privateKey);
    const minaKey = MinaPrivateKey.fromBase58(privateKey);
    return {
      kind,
      privateKey,
      address: minaKey.toPublicKey().toBase58()
    };
  }

  throw new Error(`Unsupported key kind "${input.kind}".`);
}
