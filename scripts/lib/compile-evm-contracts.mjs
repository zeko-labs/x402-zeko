import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import solc from "solc";

const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts-evm");
const DEFAULT_ARTIFACT_DIR = path.join(REPO_ROOT, "dist-evm");

async function collectSoliditySources(rootDir) {
  const sources = {};
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".sol")) {
        continue;
      }

      const sourceName = path.relative(REPO_ROOT, fullPath).replaceAll(path.sep, "/");
      sources[sourceName] = {
        content: await fs.readFile(fullPath, "utf8")
      };
    }
  }

  return sources;
}

function normalizeCompilerError(error) {
  if (!error.formattedMessage) {
    return `${error.severity}: ${error.message}`;
  }

  return error.formattedMessage.trim();
}

export async function compileEvmContracts({
  contractsDir = CONTRACTS_DIR,
  artifactDir = DEFAULT_ARTIFACT_DIR,
  writeArtifacts = true
} = {}) {
  const sources = await collectSoliditySources(contractsDir);
  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"]
        }
      }
    }
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (importPath) => {
        try {
          return {
            contents: require("node:fs").readFileSync(require.resolve(importPath), "utf8")
          };
        } catch {
          try {
            return {
              contents: require("node:fs").readFileSync(path.join(REPO_ROOT, importPath), "utf8")
            };
          } catch (error) {
            return {
              error: `File not found: ${importPath} (${error.message})`
            };
          }
        }
      }
    })
  );

  const errors = output.errors ?? [];
  const fatalErrors = errors.filter((error) => error.severity === "error");
  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map(normalizeCompilerError).join("\n\n"));
  }

  if (writeArtifacts) {
    await fs.rm(artifactDir, { recursive: true, force: true });
    await fs.mkdir(artifactDir, { recursive: true });
  }

  const artifacts = [];
  for (const [sourceName, contracts] of Object.entries(output.contracts ?? {})) {
    for (const [contractName, contractOutput] of Object.entries(contracts)) {
      const artifact = {
        contractName,
        sourceName,
        abi: contractOutput.abi,
        bytecode: `0x${contractOutput.evm.bytecode.object}`,
        deployedBytecode: `0x${contractOutput.evm.deployedBytecode.object}`
      };
      artifacts.push(artifact);

      if (writeArtifacts) {
        const fileName = `${contractName}.json`;
        await fs.writeFile(
          path.join(artifactDir, fileName),
          `${JSON.stringify(artifact, null, 2)}\n`,
          "utf8"
        );
      }
    }
  }

  return {
    artifacts,
    warnings: errors
      .filter((error) => error.severity !== "error")
      .map(normalizeCompilerError),
    artifactDir
  };
}

export async function loadCompiledArtifact(contractName, options = {}) {
  const { artifacts } = await compileEvmContracts({ ...options, writeArtifacts: false });
  const artifact = artifacts.find((entry) => entry.contractName === contractName);
  if (!artifact) {
    throw new Error(`Missing compiled artifact for ${contractName}`);
  }

  return artifact;
}
