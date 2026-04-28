#!/usr/bin/env node

import {
  buildEnvExport,
  defaultKeyringPath,
  formatEnvExport,
  generateEvmKey,
  generateMinaKey,
  importManagedKey,
  listManagedKeys,
  readManagedKey,
  storeManagedKey
} from "../src/key-manager.js";

function takeFlag(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function requireArg(label, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function resolvePassphrase(args) {
  return (
    takeFlag(args, "--passphrase") ||
    process.env.X402_KEY_MANAGER_PASSPHRASE ||
    ""
  );
}

function usage() {
  return `
zeko-x402-key-manager

Commands:
  generate evm --name NAME [--path FILE] [--passphrase PASS] [--json]
  generate mina --name NAME [--path FILE] [--passphrase PASS] [--json]
  import evm --name NAME --private-key KEY [--path FILE] [--passphrase PASS] [--json]
  import mina --name NAME --private-key KEY [--path FILE] [--passphrase PASS] [--json]
  list [--path FILE] [--json]
  show --name NAME [--path FILE] [--passphrase PASS] [--json]
  export-env --name NAME --role ROLE [--path FILE] [--passphrase PASS]

Roles:
  buyer | relayer | payto | zeko-payer | zeko-beneficiary
`.trim();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];
  const filePath = takeFlag(args, "--path", defaultKeyringPath());
  const json = hasFlag(args, "--json");

  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }

  if (command === "list") {
    const entries = await listManagedKeys(filePath);
    console.log(
      json ? JSON.stringify(entries, null, 2) : entries.map((entry) => `${entry.name} ${entry.kind} ${entry.address}`).join("\n")
    );
    return;
  }

  if (command === "generate") {
    const name = requireArg("--name", takeFlag(args, "--name"));
    const passphrase = requireArg("--passphrase or X402_KEY_MANAGER_PASSPHRASE", resolvePassphrase(args));
    const generated =
      subcommand === "evm"
        ? generateEvmKey()
        : subcommand === "mina"
          ? generateMinaKey()
          : (() => {
              throw new Error(`Unsupported generate target "${subcommand}".`);
            })();
    const stored = await storeManagedKey({
      filePath,
      passphrase,
      name,
      kind: generated.type,
      privateKey: generated.privateKey,
      address: generated.address
    });
    const output = {
      name,
      kind: stored.kind,
      address: stored.address,
      filePath
    };
    console.log(json ? JSON.stringify(output, null, 2) : `${output.name} ${output.kind} ${output.address}`);
    return;
  }

  if (command === "import") {
    const name = requireArg("--name", takeFlag(args, "--name"));
    const passphrase = requireArg("--passphrase or X402_KEY_MANAGER_PASSPHRASE", resolvePassphrase(args));
    const privateKey = requireArg("--private-key", takeFlag(args, "--private-key"));
    const imported = importManagedKey({
      kind: requireArg("import target", subcommand),
      privateKey
    });
    const stored = await storeManagedKey({
      filePath,
      passphrase,
      name,
      kind: imported.kind,
      privateKey: imported.privateKey,
      address: imported.address
    });
    const output = {
      name,
      kind: stored.kind,
      address: stored.address,
      filePath
    };
    console.log(json ? JSON.stringify(output, null, 2) : `${output.name} ${output.kind} ${output.address}`);
    return;
  }

  if (command === "show") {
    const name = requireArg("--name", takeFlag(args, "--name"));
    const passphrase = requireArg("--passphrase or X402_KEY_MANAGER_PASSPHRASE", resolvePassphrase(args));
    const entry = await readManagedKey({ filePath, passphrase, name });
    const output = {
      name: entry.name,
      kind: entry.kind,
      address: entry.address,
      privateKey: entry.privateKey
    };
    console.log(json ? JSON.stringify(output, null, 2) : `${output.name} ${output.kind} ${output.address}`);
    return;
  }

  if (command === "export-env") {
    const name = requireArg("--name", takeFlag(args, "--name"));
    const role = requireArg("--role", takeFlag(args, "--role"));
    const passphrase = requireArg("--passphrase or X402_KEY_MANAGER_PASSPHRASE", resolvePassphrase(args));
    const entry = await readManagedKey({ filePath, passphrase, name });
    const env = buildEnvExport(role, entry);
    console.log(formatEnvExport(env));
    return;
  }

  throw new Error(`Unknown command "${command}".`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
