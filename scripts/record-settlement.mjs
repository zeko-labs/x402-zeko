import { persistSettlementWitnessUpdate } from "../src/index.js";

const [, , statePathArg, paymentKey, paymentLeaf, txHash] = process.argv;

if (!statePathArg || !paymentKey || !paymentLeaf) {
  console.error(
    "usage: node scripts/record-settlement.mjs <statePath> <paymentKey> <paymentLeaf> [txHash]"
  );
  process.exit(1);
}

const metadata = {
  ...(typeof txHash === "string" && txHash.length > 0 ? { txHash } : {})
};

const store = await persistSettlementWitnessUpdate(
  statePathArg,
  {
    paymentKey,
    paymentLeaf
  },
  metadata
);

console.log(
  JSON.stringify(
    {
      ok: true,
      statePath: statePathArg,
      entryCount: store.entries.length,
      paymentKey
    },
    null,
    2
  )
);
