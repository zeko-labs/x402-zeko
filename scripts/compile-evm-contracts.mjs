import { compileEvmContracts } from "./lib/compile-evm-contracts.mjs";

const result = await compileEvmContracts();

for (const warning of result.warnings) {
  console.warn(warning);
}

for (const artifact of result.artifacts) {
  console.log(`compiled ${artifact.contractName} -> dist-evm/${artifact.contractName}.json`);
}
