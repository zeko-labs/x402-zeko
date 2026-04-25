# Testnet Smoke Flow

`zeko-x402` now includes a single-command Zeko testnet smoke runner at `pnpm smoke:zeko-flow`.

It exercises the intended happy path:

1. build the x402 catalog and `402 Payment Required` challenge
2. choose the advertised Zeko rail
3. build and sign the `sendZkapp` settlement transaction
4. submit it to Zeko GraphQL
5. wait for transaction acceptance/visibility
6. persist the returned `settlementWitnessUpdate`
7. emit a `PAYMENT-RESPONSE` receipt and mock paid resource payload

## Required env

- `ZEKO_GRAPHQL`
  Default: `https://testnet.zeko.io/graphql`
- `ZEKO_ARCHIVE`
  Default: `https://archive.testnet.zeko.io/graphql`
- one of `X402_PAYER_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY`, `MINA_PRIVATE_KEY`, `WALLET_PRIVATE_KEY`
- `X402_ZKAPP_PUBLIC_KEY`

## Optional env

- `X402_WITNESS_SERVICE_URL`
  Use an HTTP witness service instead of a local JSON file.
- `X402_SETTLEMENT_STATE_PATH`
  Default local witness file when `X402_WITNESS_SERVICE_URL` is unset.
- `X402_AMOUNT_MINA`
  Default: `0.015` `tMINA`
- `X402_FEE_MINA`
  Default: `0.10` `tMINA`
- `X402_SERVICE_ID`, `X402_SESSION_ID`, `X402_TURN_ID`, `X402_PAYMENT_ID`
- `X402_BASE_URL`, `X402_PROOF_BUNDLE_URL`, `X402_VERIFY_URL`
- `X402_WAIT_ATTEMPTS`, `X402_WAIT_INTERVAL_MS`

## Typical sequence

1. Deploy and configure the settlement contract.
2. Start `pnpm witness:serve` or point `X402_WITNESS_SERVICE_URL` at your own witness service.
3. Export `X402_ZKAPP_PUBLIC_KEY` plus a payer private key with testnet `tMINA`.
4. Run `pnpm smoke:zeko-flow`.

The script prints JSON containing:

- the advertised x402 catalog and requirement
- the signed payment payload
- the submitted transaction hash and observed status
- Base64-encoded `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` header payloads
- the witness update that was persisted after acceptance

## Important rule

The smoke runner follows the same production rule as the library:

- do not advance witness state during auth generation
- only persist `authorization.settlementWitnessUpdate` after the transaction has been accepted or observed on-chain
