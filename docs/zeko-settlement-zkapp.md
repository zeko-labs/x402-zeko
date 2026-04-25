# Zeko Settlement zkApp

The standalone package now includes a concrete zkApp contract interface at `contracts/X402SettlementContract.ts`.

## Contract state

- `beneficiary: PublicKey`
- `serviceCommitment: Field`
- `settlementRoot: Field`

`settlementRoot` is a Merkle-map style nullifier root. Each `(requestId, paymentId)` pair occupies one leaf, so replay protection lives onchain instead of only in the facilitator.

## Main method

`settleExact(requestIdHash, paymentIdHash, payer, beneficiary, amountNanomina, paymentContextDigest, resourceDigest, paymentWitness)`

The method:

- checks the configured beneficiary
- checks that the leaf for this payment is still empty
- writes a new settlement leaf derived from the payment context
- emits an `exactSettlement` event with the updated root

## Offchain hashing convention

The JS helper in `src/zeko-settlement-contract.js` is the source of truth for the offchain encoding used by the client:

- `requestId` and `paymentId` are Poseidon-hashed from UTF-8 bytes
- `paymentContextDigest` and `resourceDigest` are hashed from hex bytes when possible, otherwise UTF-8
- `paymentKey = Poseidon(requestIdHash, paymentIdHash)`
- `settlementLeaf = Poseidon(requestIdHash, paymentIdHash, payer, beneficiary, amount, paymentContextDigest, resourceDigest, serviceCommitment)`

This keeps the contract surface field-native while letting the x402 layer continue to use ordinary strings and SHA-256 digests.

## Client hook

`prepareSignedZekoSettlementAuthorization(...)` can now use:

- a custom `applyContractCall(...)`, or
- `settlementContract.{ContractClass|createContract,witnessProvider|statePath|witnessServiceUrl|inMemoryWitnessState}`

That means one caller can plug in the actual `X402SettlementContract` class plus a witness provider and get a signed `sendZkapp` authorization without rewriting the transaction body each time.

## Persistent witness flow

The standalone package now includes:

- `src/settlement-store.js`
- `pnpm witness:serve`
- `pnpm witness:record`

The important operational detail is that witness state is not advanced during transaction construction anymore. Instead:

1. build the signed authorization
2. submit the `sendZkapp`
3. after the transaction is accepted/confirmed, persist `authorization.settlementWitnessUpdate`

That keeps the offchain Merkle-map state aligned with the actual onchain settlement root.
