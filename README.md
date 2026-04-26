# zeko-x402

`zeko-x402` is a standalone x402 starter for Zeko-centric services.

It keeps the parts people like about x402 on Base and Coinbase:

- standard `402 Payment Required` negotiation
- `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` headers
- exact-price payment requirements
- multiple `accepts` rails on the same resource
- replay-safe settlement handling

It also carries Zeko- and ZK-specific metadata alongside the payment rail:

- programmable-privacy hints
- proof bundle digest attestation
- kernel path hints for reserve/settle/refund flows

Default settlement assets in this repo are:

- Base mainnet: canonical USDC
- Ethereum mainnet: canonical USDC
- Zeko testnet: `tMINA`, the canonical Zeko testnet gas token

This project is intentionally separate from `clawz`. Its goal is to let one Zeko-backed service optionally ask for payment on either:

- Zeko itself
- an EVM chain such as Base, Ethereum mainnet, or another `eip155:<chainId>` network

It now carries signed payment authorization payloads, can submit signed Zeko GraphQL payment/zkApp commands, and can either call an external HTTP facilitator or relay EVM settlement itself for Base/Ethereum USDC. The remaining app-specific piece is the actual zkApp contract call body for your Zeko settlement contract.

## Status

This repo is intentionally narrow in scope today:

- implemented here: Zeko testnet settlement, Base mainnet USDC, Ethereum mainnet USDC
- deployment-ready here: self-hosted EVM facilitator and Zeko settlement/witness flows
- not implemented here yet: Solana and other non-EVM hosted x402 rails

That keeps the package honest about what is production-usable right now versus what is still future work.

## Files

- `src/protocol.js`: shared x402 header, asset, and payload helpers
- `src/facilitator.js`: Zeko rail builders, EVM rail builders, payment requirement/catalog builders, and settlement receipts
- `src/facilitator-client.js`: generic HTTP facilitator client plus hosted/CDP facilitator adapters
- `src/evm-facilitator.js`: self-hosted EVM verifier/relayer for Base or Ethereum USDC plus an HTTP server wrapper
- `src/targets.js`: concrete target builders for Zeko settlement contracts, Base mainnet USDC, and Ethereum mainnet USDC
- `src/intents.js`: concrete Zeko, Base, and Ethereum settlement intent builders
- `src/payments.js`: signed authorization builders and signed payment payload helpers
- `src/settlement-store.js`: file-backed settlement store plus witness-provider, witness-service, and witness-record helpers
- `src/zeko-settlement-contract.js`: offchain helpers for the Zeko settlement zkApp call, hashing, and witness wiring
- `src/zeko-client.js`: Zeko GraphQL submitter, transaction-status polling, and `o1js`-backed settlement authorization preparation
- `contracts/X402SettlementContract.ts`: concrete zkApp contract interface for `settleExact(...)`
- `zkapp/*.ts`: compile/deploy/read-state scripts for the settlement contract
- `src/ledger.js`: small in-memory settlement ledger with duplicate protection for any configured asset
- `test/facilitator.test.mjs`: end-to-end happy-path coverage

See `docs/settlement-primitives.md` for the current recommended Zeko and EVM settlement primitives, `docs/zeko-settlement-zkapp.md` for the contract/client boundary, `docs/testnet-smoke-flow.md` for the live Zeko testnet loop, `docs/evm-hosted-facilitators.md` for Base vs Ethereum hosted/self-hosted facilitator behavior, and `docs/multirail-paid-resource.md` for the shared `402` offer that advertises EVM plus Zeko together.

## Execution Paths

- Zeko native fallback: build a `zeko-native-payment-v1` intent, wrap a signed payment into an authorization object, then submit it through `submitZekoAuthorization(...)`.
- Zeko settlement contract: build a `zeko-exact-settlement-zkapp-v1` intent, compute a stable `paymentContextDigest`, then call `prepareSignedZekoSettlementAuthorization(...)` with either a custom `applyContractCall(...)` or `settlementContract.{ContractClass|createContract,witnessProvider|statePath|witnessServiceUrl|inMemoryWitnessState}`.
- EVM / Base or Ethereum USDC: build an EIP-3009 authorization, wrap it in `buildSignedPaymentPayload(...)`, then hand it to `HostedX402FacilitatorClient`, `CDPFacilitatorClient`, or `SelfHostedEvmFacilitator`.

## Scripts

If a local `.env` file exists, the runtime scripts below now load it automatically.
For release hygiene, start from `.env.example` and keep real keys in an external secret manager or the local encrypted keyring.

- `pnpm test`: run the standalone protocol/client tests
- `pnpm build:zkapp`: compile the zkApp contract and helper scripts to `dist-zkapp/`
- `pnpm key-manager`: run the encrypted local key manager
- `pnpm doctor:rails`: check whether the Base/EVM and Zeko rails are actually ready for a live run
- `pnpm doctor:ethereum`: check the Ethereum mainnet rail specifically
- `pnpm evm:facilitator`: start the self-hosted Base/Ethereum x402 facilitator on `127.0.0.1:7422` by default
- `pnpm zkapp:deploy`: compile and deploy/configure the x402 settlement contract on Zeko
- `pnpm zkapp:get-state`: read `beneficiary`, `serviceCommitment`, and `settlementRoot`
- `pnpm smoke:evm-flow`: run the hosted-facilitator EVM smoke flow for Base or Ethereum mainnet
- `pnpm smoke:ethereum-flow`: run the Ethereum mainnet smoke flow explicitly
- `pnpm smoke:multirail-offer`: build a single `402 Payment Required` offer that advertises Base, optional Ethereum mainnet, and Zeko together
- `pnpm smoke:zeko-flow`: run the `402 -> sign -> sendZkapp -> wait -> persist witness update -> fetch resource` smoke flow on Zeko testnet
- `pnpm pack:dry-run`: preview the exact npm tarball contents without publishing
- `pnpm witness:serve`: start a tiny witness HTTP service backed by a JSON settlement-state file
- `pnpm witness:record`: persist a confirmed `(paymentKey, paymentLeaf)` update into the settlement-state file

## Facilitator Hosting

You do not have to self-host every rail.

- Base can use a hosted x402 facilitator when you want CDP-style managed settlement behavior.
- Ethereum mainnet currently needs either your own facilitator endpoint or the built-in self-hosted relayer path in this repo.
- Zeko is its own rail entirely, so if you want Zeko-native settlement you still host that path yourself. On testnet, that rail is priced and advertised in `tMINA`.

If you want one deployment path that works for Base and Ethereum today, use the self-hosted facilitator in this repo.
`render.yaml` is included for a simple Render web-service deploy, and the facilitator already exposes `GET /health`, `GET /supported`, `POST /verify`, and `POST /settle`.

## Operational Rule

The witness store is now explicit on purpose: `prepareSignedZekoSettlementAuthorization(...)` returns a `settlementWitnessUpdate`, but it does not mutate persistent settlement state by itself. Persist that update only after the `sendZkapp` transaction has been accepted or confirmed.

Run `pnpm doctor:rails` before the live smokes. It checks:

- whether the Base/EVM rail is missing its private key, payee, or facilitator credentials
- whether the self-hosted EVM rail is missing an RPC URL or relayer key
- whether the Zeko rail has a funded payer key and deployed zkApp configured
- whether the current Zeko `settlementRoot` matches the configured witness store or witness service

If the Zeko doctor reports a root mismatch, the next live settlement cannot succeed until the witness state matches the deployed contract again. In that case, point `X402_SETTLEMENT_STATE_PATH` / `X402_WITNESS_SERVICE_URL` at the matching witness state or deploy a fresh settlement zkApp with a fresh witness store.

## Multi-Rail Offer

The intended front door is a single x402 `402 Payment Required` response with EVM rails first and Zeko alongside them:

- Base mainnet USDC should usually come first so Coinbase/Base/x402 clients see the default path they already expect.
- Ethereum mainnet USDC can be included too, but it still needs either a custom hosted facilitator endpoint or a self-hosted relayer.
- Zeko can sit beside those rails as the upgraded path for verified-result or privacy-forward flows.

Generate that combined offer with:

```bash
X402_EVM_PAY_TO=0x1111111111111111111111111111111111111111 \
X402_ZKAPP_PUBLIC_KEY=B62q... \
pnpm smoke:multirail-offer
```

If `X402_ZEKO_BENEFICIARY_PUBLIC_KEY` is not set, the script will read the beneficiary from the live Zeko settlement contract before building the shared `PAYMENT-REQUIRED` header.

## Self-Hosted EVM

If you do not want to depend on CDP for settlement, `zeko-x402` can relay the same EIP-3009 `TransferWithAuthorization` payment itself.

Run the relayer:

```bash
X402_BASE_RPC_URL=https://... \
X402_EVM_RELAYER_PRIVATE_KEY=0x... \
pnpm evm:facilitator
```

Then point the smoke flow at it:

```bash
X402_EVM_NETWORK=base \
X402_EVM_PRIVATE_KEY=0x... \
X402_BASE_PAY_TO=0x1111111111111111111111111111111111111111 \
X402_EVM_FACILITATOR_URL=http://127.0.0.1:7422 \
pnpm smoke:evm-flow
```

You can also skip the separate server and let `pnpm smoke:evm-flow` build the facilitator in-process when `X402_EVM_RPC_URL` plus `X402_EVM_RELAYER_PRIVATE_KEY` are set and no hosted facilitator URL/token is configured.

Production note: prefer `X402_BASE_PAY_TO`, `X402_ETHEREUM_PAY_TO`, or `X402_EVM_PAY_TO`. Older legacy aliases are still accepted for backward compatibility. Keep `payTo` separate from the relayer wallet in production: the buyer pays `payTo`, while the relayer only submits the transaction and pays gas.

## Local Key Manager

`zeko-x402` now includes an encrypted local key manager so you can generate or import operator wallets without hard-coding them into the repo:

```bash
X402_KEY_MANAGER_PASSPHRASE=choose-a-passphrase \
pnpm key-manager generate evm --name payto --json
```

Export env values for a role:

```bash
X402_KEY_MANAGER_PASSPHRASE=choose-a-passphrase \
pnpm key-manager export-env --name payto --role payto
```

Supported export roles:

- `buyer`
- `relayer`
- `payto`
- `zeko-payer`
- `zeko-beneficiary`

Publishing checklist: [docs/publishing.md](./docs/publishing.md)

Ethereum L1 can be wired the same way:

```bash
X402_ETHEREUM_RPC_URL=https://... \
X402_ETHEREUM_PAY_TO=0x1111111111111111111111111111111111111111 \
pnpm smoke:ethereum-flow
```

## Quick Example

```js
import {
  InMemorySettlementLedger,
  buildAuthorizationDigest,
  buildBaseMainnetUsdcRail,
  buildBaseUsdcCircleGatewayIntent,
  buildCatalog,
  buildPaymentRequired,
  buildSettlementResponse,
  buildZekoExactSettlementIntent,
  buildZekoSettlementContractRail,
  verifyPayment
} from "zeko-x402";

const context = {
  serviceId: "zeko-proof-service",
  baseUrl: "https://example.com",
  proofBundleUrl: "https://example.com/api/proof",
  verifyUrl: "https://example.com/api/proof/verify",
  sessionId: "session_demo",
  turnId: "turn_001",
  rails: [
    buildZekoSettlementContractRail({
      contractAddress: "B62qcontract11111111111111111111111111111111111111111111111111111",
      beneficiaryAddress: "B62qbeneficiary1111111111111111111111111111111111111111111111111",
      amount: "0.015",
      bundleDigestSha256: "proof_bundle_digest_demo",
      programmablePrivacy: {
        selectedLocation: "server",
        options: [{ location: "server", label: "Server prover", available: true }]
      },
      kernelPath: ["EscrowKernel.reserveBudget", "EscrowKernel.settleTurn"]
    }),
    buildBaseMainnetUsdcRail({
      amount: "0.50",
      payTo: "0x1111111111111111111111111111111111111111"
    })
  ]
};

const catalog = buildCatalog(context);
const required = buildPaymentRequired(context);
const chosenRail = required.accepts.find((option) => option.settlementRail === "evm");
const evmLedger = new InMemorySettlementLedger({
  budgetAsset: chosenRail.asset,
  sponsoredBudget: "1.00"
});
const gatewayIntent = buildBaseUsdcCircleGatewayIntent({
  from: "0x2222222222222222222222222222222222222222",
  to: chosenRail.payTo,
  amount: chosenRail.amount,
  verifyingContract: "0x3333333333333333333333333333333333333333"
});

const payloadBase = {
  protocol: "x402",
  version: "2",
  requestId: required.requestId,
  paymentId: "pay_demo_001",
  scheme: "exact",
  settlementRail: chosenRail.settlementRail,
  networkId: chosenRail.network,
  asset: chosenRail.asset,
  amount: chosenRail.amount,
  payer: "0x2222222222222222222222222222222222222222",
  payTo: chosenRail.payTo,
  sessionId: context.sessionId,
  turnId: context.turnId,
  issuedAtIso: "2026-04-23T12:00:00.000Z",
  expiresAtIso: "2099-01-01T00:00:00.000Z"
};

const paymentPayload = {
  ...payloadBase,
  authorizationDigest: buildAuthorizationDigest(payloadBase)
};

const verification = verifyPayment({
  requirements: required,
  payload: paymentPayload,
  duplicate: false
});

if (verification.ok) {
  const settlement = evmLedger.settle({
    paymentId: paymentPayload.paymentId,
    requestId: paymentPayload.requestId,
    settlementRail: paymentPayload.settlementRail,
    amount: paymentPayload.amount,
    asset: paymentPayload.asset,
    payer: paymentPayload.payer,
    payTo: paymentPayload.payTo,
    sessionId: paymentPayload.sessionId,
    turnId: paymentPayload.turnId,
    resource: required.resource,
    networkId: paymentPayload.networkId
  });

  const receipt = buildSettlementResponse({
    payload: paymentPayload,
    duplicate: settlement.duplicate,
    eventIds: settlement.settlement.eventIds,
    settledAtIso: settlement.settlement.settledAtIso,
    remainingBudget: settlement.remainingBudget,
    sponsoredBudget: settlement.sponsoredBudget,
    budgetAsset: settlement.budgetAsset,
    proofBundleUrl: context.proofBundleUrl,
    verifyUrl: context.verifyUrl,
    settlementModel: chosenRail.settlementModel,
    evm: {
      ...chosenRail.extensions.evm,
      gatewayIntent: gatewayIntent.typedData.domain
    }
  });

  console.log(catalog.protocol, receipt.settlementState);
}
```
