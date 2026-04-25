import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  buildEnvExport,
  createEmptyKeyring,
  formatEnvExport,
  generateEvmKey,
  generateMinaKey,
  listManagedKeys,
  readKeyring,
  readManagedKey,
  storeManagedKey
} from "../src/key-manager.js";

test("key manager stores and decrypts evm keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zeko-x402-keymgr-"));
  const filePath = path.join(dir, "keys.json");
  const passphrase = "test-passphrase";
  const generated = generateEvmKey();

  await storeManagedKey({
    filePath,
    passphrase,
    name: "treasury",
    kind: generated.type,
    privateKey: generated.privateKey,
    address: generated.address
  });

  const entry = await readManagedKey({
    filePath,
    passphrase,
    name: "treasury"
  });

  assert.equal(entry.kind, "evm");
  assert.equal(entry.address, generated.address);
  assert.equal(entry.privateKey, generated.privateKey);
});

test("key manager supports mina keys and env export helpers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zeko-x402-keymgr-"));
  const filePath = path.join(dir, "keys.json");
  const passphrase = "test-passphrase";
  const generated = generateMinaKey();

  await storeManagedKey({
    filePath,
    passphrase,
    name: "zeko-payer",
    kind: generated.type,
    privateKey: generated.privateKey,
    address: generated.address
  });

  const entry = await readManagedKey({
    filePath,
    passphrase,
    name: "zeko-payer"
  });
  const env = buildEnvExport("zeko-payer", entry);

  assert.match(formatEnvExport(env), /X402_PAYER_PRIVATE_KEY=/);
  assert.equal(env.X402_PAYER_PUBLIC_KEY, generated.address);
});

test("key manager lists stored keys without exposing secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zeko-x402-keymgr-"));
  const filePath = path.join(dir, "keys.json");
  const passphrase = "test-passphrase";
  const generated = generateEvmKey();

  await storeManagedKey({
    filePath,
    passphrase,
    name: "relayer",
    kind: generated.type,
    privateKey: generated.privateKey,
    address: generated.address
  });

  const listed = await listManagedKeys(filePath);
  const keyring = await readKeyring(filePath);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "relayer");
  assert.equal(listed[0].address, generated.address);
  assert.ok(!("privateKey" in listed[0]));
  assert.equal(keyring.format, createEmptyKeyring().format);
});
