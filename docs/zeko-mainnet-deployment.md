# Zeko Mainnet Deployment

This repo does not require a hosted x402 facilitator for the Zeko-native rail. The Zeko path is a zkApp settlement rail: apps advertise it in x402, buyers sign a Zeko `sendZkapp`, and the app submits the signed transaction to Zeko.

## Network

Live read-only checks on 2026-06-29 confirmed:

- x402 network id: `zeko:zeko-mainnet`
- Zeko GraphQL: `https://mainnet.zeko.io/graphql`
- Zeko archive: `https://archive.mainnet.zeko.io/graphql`
- Explorer: `https://zekoscan.io/mainnet`
- Node-reported `networkID`: `zeko:zeko-mainnet`
- Circuit config: `chainL1: "mainnet"`, `chainL2: "zeko-mainnet"`

Testnet remains:

- x402 network id: `zeko:testnet`
- Zeko GraphQL: `https://testnet.zeko.io/graphql`
- Zeko archive: `https://archive.testnet.zeko.io/graphql`

## What Needs To Be Deployed

No EVM facilitator is needed for the Zeko-native settlement rail.

If you want Zeko-native x402 settlement on mainnet, deploy an `X402SettlementContract` zkApp on Zeko mainnet. The current contract is single-beneficiary: every successful `settleExact(...)` sends funds to the configured beneficiary and records the payment nullifier in the settlement root.

That means:

- one deployed zkApp can serve many payers for one service or seller beneficiary
- different sellers or agents that need different payout addresses should deploy their own zkApp
- a universal shared settlement contract would require a future multi-tenant contract design

## Deploy A Mainnet zkApp

Build the zkApp output:

```bash
pnpm build:zkapp
```

Set mainnet deployment env:

```bash
export ZEKO_GRAPHQL=https://mainnet.zeko.io/graphql
export ZEKO_ARCHIVE=https://archive.mainnet.zeko.io/graphql
export DEPLOYER_PRIVATE_KEY=...
export ZKAPP_PRIVATE_KEY=...
export X402_BENEFICIARY_PUBLIC_KEY=...
export X402_SERVICE_COMMITMENT=zeko-x402-mainnet
export TX_FEE=2000000000
```

Deploy and configure:

```bash
pnpm zkapp:deploy
```

Verify the deployed contract state:

```bash
export X402_ZKAPP_PUBLIC_KEY=<deployed-zkapp-public-key>
pnpm zkapp:get-state
```

## Advertise Mainnet In x402

Use the mainnet selector when building Zeko rails or running smoke scripts:

```bash
export X402_ZEKO_NETWORK=mainnet
export X402_ZKAPP_PUBLIC_KEY=<deployed-zkapp-public-key>
export ZEKO_GRAPHQL=https://mainnet.zeko.io/graphql
export ZEKO_ARCHIVE=https://archive.mainnet.zeko.io/graphql
```

`buildZekoSettlementContractRail(...)` and `buildZekoExactSettlementIntent(...)` also accept `network: "mainnet"` or `networkId: "zeko:zeko-mainnet"` directly.

## Smoke And Operations

Build a mainnet-aware x402 offer without submitting a transaction:

```bash
X402_ZEKO_NETWORK=mainnet pnpm smoke:multirail-offer
```

Run a live mainnet Zeko settlement smoke only when you have a funded payer key and a matching persistent witness store:

```bash
X402_ZEKO_NETWORK=mainnet pnpm smoke:zeko-flow
```

Operational requirements:

- keep a persistent witness store per deployed settlement zkApp
- do not advance witness state until a transaction is accepted or observed onchain
- fund the payer/deployer with mainnet MINA before live smokes or deployments
- use distinct zkApps when the beneficiary, service commitment, or witness root should be isolated

