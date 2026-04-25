function trimFraction(value) {
  return value.replace(/\.?0+$/, "");
}

function assertDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid asset decimals: ${decimals}`);
  }

  return decimals;
}

function sameAsset(left, right) {
  const leftAddress = typeof left.address === "string" ? left.address.toLowerCase() : null;
  const rightAddress = typeof right.address === "string" ? right.address.toLowerCase() : null;

  return (
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    (left.standard ?? null) === (right.standard ?? null) &&
    leftAddress === rightAddress
  );
}

export function toAtomicUnits(value, decimals) {
  const normalizedDecimals = assertDecimals(decimals);
  const fractionPattern = normalizedDecimals > 0 ? `(\\.\\d{1,${normalizedDecimals}})?` : "";
  const amountPattern = new RegExp(`^\\d+${fractionPattern}$`);

  if (typeof value !== "string" || !amountPattern.test(value)) {
    throw new Error(`Invalid amount: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  const unitSize = 10n ** BigInt(normalizedDecimals);
  const fractionPadded = `${fraction}${"0".repeat(normalizedDecimals)}`.slice(0, normalizedDecimals);

  return BigInt(whole) * unitSize + BigInt(fractionPadded || "0");
}

export function fromAtomicUnits(value, decimals) {
  const normalizedDecimals = assertDecimals(decimals);
  const unitSize = 10n ** BigInt(normalizedDecimals);
  const whole = value / unitSize;
  const fraction = normalizedDecimals > 0
    ? String(value % unitSize).padStart(normalizedDecimals, "0")
    : "";
  const normalized = trimFraction(`${whole}.${fraction}`);
  return normalized.length === 0 ? "0" : normalized;
}

export class InMemorySettlementLedger {
  constructor(input = {}) {
    const budgetAsset = input.budgetAsset ?? {
      symbol: "MINA",
      decimals: 9,
      standard: "native"
    };
    const sponsoredBudget = input.sponsoredBudget ?? "0.500";

    this.budgetAsset = budgetAsset;
    this.sponsoredBudget = sponsoredBudget;
    this.sponsoredRemaining = input.sponsoredRemaining ?? sponsoredBudget;
    this.settlements = new Map();
  }

  inspect(paymentId) {
    return this.settlements.get(paymentId);
  }

  settle(input) {
    const existing = this.inspect(input.paymentId);

    if (existing) {
      if (
        existing.requestId !== input.requestId ||
        existing.amount !== input.amount ||
        existing.payer !== input.payer ||
        existing.payTo !== input.payTo
      ) {
        throw new Error(`x402 payment id ${input.paymentId} was already used for a different settlement.`);
      }

      return {
        duplicate: true,
        settlement: existing,
        remainingBudget: this.sponsoredRemaining,
        sponsoredBudget: this.sponsoredBudget,
        budgetAsset: this.budgetAsset
      };
    }

    if (!sameAsset(input.asset, this.budgetAsset)) {
      throw new Error("Settlement asset does not match this ledger's sponsored budget asset.");
    }

    const amount = toAtomicUnits(input.amount, input.asset.decimals);

    if (amount <= 0n) {
      throw new Error("x402 amount must be greater than zero.");
    }

    const remaining = toAtomicUnits(this.sponsoredRemaining, this.budgetAsset.decimals);

    if (remaining < amount) {
      throw new Error(
        `Insufficient sponsored budget for x402 settlement. Need ${input.amount} ${input.asset.symbol} but only ${this.sponsoredRemaining} ${this.budgetAsset.symbol} remains.`
      );
    }

    const settledAtIso = input.now ?? new Date().toISOString();
    const turnId = input.turnId ?? `turn_x402_${input.paymentId.slice(-12)}`;
    const settlement = {
      paymentId: input.paymentId,
      requestId: input.requestId,
      settlementRail: input.settlementRail,
      amount: input.amount,
      asset: input.asset,
      payer: input.payer,
      payTo: input.payTo,
      sessionId: input.sessionId,
      turnId,
      resource: input.resource,
      networkId: input.networkId,
      eventIds: [
        `evt_x402_budget_${input.paymentId}`,
        `evt_x402_settle_${input.paymentId}`
      ],
      settledAtIso,
      ...(input.settlementReference ? { settlementReference: input.settlementReference } : {})
    };

    this.sponsoredRemaining = fromAtomicUnits(remaining - amount, this.budgetAsset.decimals);
    this.settlements.set(input.paymentId, settlement);

    return {
      duplicate: false,
      settlement,
      remainingBudget: this.sponsoredRemaining,
      sponsoredBudget: this.sponsoredBudget,
      budgetAsset: this.budgetAsset
    };
  }
}
