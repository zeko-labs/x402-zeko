# Settlement Primitives

`zeko-x402` now treats settlement as two concrete tracks instead of two abstract ideas.

## Zeko rail

Canonical primitive: `zeko-exact-settlement-zkapp-v1`

This is the Zeko-native settlement primitive we want to trigger once we wire the rail into a live client:

- build an `o1js` transaction against a Zeko custom network
- include a signed `tMINA` transfer from payer into a settlement contract on Zeko testnet
- include a zkApp method call such as `settleExact(...)`
- bind the transaction to a stable `paymentContextDigest`
- emit an onchain event keyed by `paymentId` for replay protection and proof binding

The important thing is that payment is not "just a transfer". It is a transfer plus a proof-backed settlement call, which is where the ZK-native behavior lives.

The concrete zkApp interface is now scaffolded in `contracts/X402SettlementContract.ts`, with the offchain hashing and witness adapter in `src/zeko-settlement-contract.js`.

Fallback primitive: `zeko-native-payment-v1`

This exists only as a compatibility path. It uses the public GraphQL `sendPayment` mutation for plain native-token transfers when a contract-backed settlement rail is not available yet.

Current default asset conventions in `zeko-x402`:

- Zeko testnet: `tMINA`
- Base mainnet: canonical USDC
- Ethereum mainnet: canonical USDC

## EVM rail

First concrete target: Base mainnet USDC

- network: `eip155:8453`
- asset: USDC
- token address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- transfer method: EIP-3009

Two execution modes are now modeled:

- `evm-base-usdc-exact-eip3009-v1`
  - standard x402 exact EVM settlement
- `evm-base-usdc-circle-gateway-v1`
  - Circle Gateway batching, which is a concrete x402-compatible facilitator-backed path

For Gateway, the `402` payment option must supply the batching contract as `verifyingContract`, and the client signs the `GatewayWalletBatched` EIP-712 domain.

## What is executable now

- Signed payment payloads can now carry the actual Zeko or EVM authorization object instead of just settlement metadata.
- Zeko signed native payments and signed zkApp commands can be submitted through the standalone client helpers.
- Zeko exact-settlement flows can use a file-backed or HTTP-backed witness provider instead of the old in-memory-only demo path.
- Base USDC payments can now be handed to an external x402-compatible facilitator over HTTP `/verify` and `/settle`.
