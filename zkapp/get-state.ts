import 'reflect-metadata';

import { fetchAccount, Mina, PublicKey } from 'o1js';

import { X402SettlementContract } from '../contracts/X402SettlementContract.js';
import { readOptionalEnv, requireEnv } from './utils.js';

async function main() {
  const graphql = requireEnv('ZEKO_GRAPHQL');
  const archive = readOptionalEnv('ZEKO_ARCHIVE', graphql);
  const zkappAddress = PublicKey.fromBase58(requireEnv('X402_ZKAPP_PUBLIC_KEY'));

  Mina.setActiveInstance(
    Mina.Network({
      mina: graphql,
      archive
    })
  );

  const result = await fetchAccount({ publicKey: zkappAddress });
  if (result.error) {
    throw new Error(`x402 settlement zkapp not found at ${zkappAddress.toBase58()}`);
  }

  const zkapp = new X402SettlementContract(zkappAddress);

  console.log(
    JSON.stringify(
      {
        ok: true,
        zkappAddress: zkappAddress.toBase58(),
        beneficiary: zkapp.beneficiary.get().toBase58(),
        serviceCommitment: zkapp.serviceCommitment.get().toString(),
        settlementRoot: zkapp.settlementRoot.get().toString()
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[zeko-x402:zkapp:get-state] failed', error);
  process.exit(1);
});
