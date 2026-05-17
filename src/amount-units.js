export function resolveEvmAmountUnit(input) {
  const amountUnit = input?.extensions?.evm?.amountUnit;

  if (amountUnit === "atomic" || amountUnit === "decimal") {
    return amountUnit;
  }

  return "decimal";
}
