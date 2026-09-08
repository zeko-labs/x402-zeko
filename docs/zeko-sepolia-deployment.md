# Zeko Sepolia Deployment

Zeko Ethereum Sepolia is the active Zeko-native x402 settlement target.
Ethereum and Base EVM rails are unchanged; this page only covers the Zeko
zkApp settlement rail.

## Network

Use this split:

- x402 rail network: `zeko:sepolia`
- live node-reported network: `zeko:testnet`
- o1js signing network: `testnet`
- GraphQL: `https://sepolia.zeko.io/graphql`
- Archive/read endpoint: `https://sepolia.zeko.io/graphql`
- Native asset: `sETH`
- Native asset decimals: `9`
- Native asset token id: `wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf`
- Static fee: `200000` native units

Do not use the retired Mina-backed endpoints for executable Zeko x402 flows:
`https://testnet.zeko.io/graphql`, `https://archive.testnet.zeko.io/graphql`,
`https://mainnet.zeko.io/graphql`, or `https://archive.mainnet.zeko.io/graphql`.

## What Needs To Be Deployed

No hosted x402 facilitator is needed for the Zeko-native rail. The EVM
facilitator remains relevant only for Ethereum/Base/EVM settlement.

To support Zeko-native x402 settlement, deploy a fresh
`X402SettlementContract` zkApp on Zeko Ethereum Sepolia. The current contract is
single-beneficiary: every successful `settleExact(...)` sends native `sETH` to
the configured beneficiary and records the payment nullifier in the settlement
root.

That means one deployed zkApp can serve many payers for one service or seller
beneficiary. Different sellers or agents that need different payout addresses
should deploy their own zkApp, or the protocol needs a future multi-tenant
contract design.

## Current Public Deployment

The first refreshed Zeko Sepolia x402 settlement zkApp was deployed on
2026-09-03 for smoke testing and integration validation:

- contract: `B62qqb9HqChXa8k4dukxRA6EZ76LzeuJKCpEcBsyicb5aTLoQg9J9rU`
- beneficiary: `B62qqsTbSjdgqzhUojPZRrWYmmf6BVsRrjwjuKsHpuaeaoob8YsDuNi`
- service commitment label: `zeko-x402-sepolia`
- service commitment field:
  `23561284143794776192063241323344399571941475505127229922237087238936792394493`
- deploy transaction: `5Ju9xmY4hyw8jTMNgofkiK5W724L3RQPKiiMAYT98rH9BDmLRX34`
- configure transaction: `5JtnJ96mooYZuP5HzFkpEoAGHsn13XWaGBYyzPdzQA7CsHVJ1x3H`
- live settlement smoke transaction:
  `5JuwmsvgjFJPGZmRb5rMpQ63KPjct5VhJLMwn9Q6PHM28niaZAer`
- post-smoke settlement root:
  `17692916321097698317286830633852190151339948985779102009292032403129074414419`

The smoke transaction was observed through the contract `events` query with
status `["Applied"]`. Keep the matching witness state private to the operator;
publish only addresses, roots, and transaction hashes.

## Deploy A Fresh zkApp

Generate a fresh zkApp key and use a fresh witness store. Do not reuse the old
Mina-backed contract key or witness state.

```bash
pnpm build:zkapp

export X402_ZEKO_NETWORK=zeko:sepolia
export ZEKO_O1JS_NETWORK_ID=testnet
export ZEKO_GRAPHQL=https://sepolia.zeko.io/graphql
export ZEKO_ARCHIVE=https://sepolia.zeko.io/graphql
export DEPLOYER_PRIVATE_KEY=...
export ZKAPP_PRIVATE_KEY=...
export X402_BENEFICIARY_PUBLIC_KEY=...
export X402_SERVICE_COMMITMENT=zeko-x402-sepolia
export TX_FEE=200000

pnpm zkapp:deploy
```

Verify the deployed contract state:

```bash
export X402_ZKAPP_PUBLIC_KEY=<deployed-zkapp-public-key>
pnpm zkapp:get-state
```

## Smoke

Build a Sepolia-aware x402 offer without submitting a transaction:

```bash
X402_ZEKO_NETWORK=zeko:sepolia pnpm smoke:multirail-offer
```

Run a live Zeko settlement smoke only after the zkApp is deployed, the payer is
funded with `sETH`, and `X402_SETTLEMENT_STATE_PATH` or
`X402_WITNESS_SERVICE_URL` points at a fresh witness store for that exact
contract:

```bash
X402_ZEKO_NETWORK=zeko:sepolia pnpm smoke:zeko-flow
```

Operational rules:

- keep a persistent witness store per deployed settlement zkApp
- do not advance witness state until a transaction is accepted or observed onchain
- use native `sETH` payment flows, not fungible-token transfer-contract flows
- keep MBA or other app authorization receipts separate from x402 settlement,
  then bind them through receipt/payment-context digests
