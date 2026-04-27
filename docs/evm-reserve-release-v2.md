# Base Reserve-Release v2

`zeko-x402` now includes a narrowly scoped EVM v2 path for proof-gated settlement on Base mainnet.

This path exists because a plain EIP-3009 payment authorization is not enough to guarantee payment after expensive private work has already run. In v1, the safe default is still:

1. settle payment
2. run work

The v2 path introduces a stronger option:

1. reserve payment up front
2. run work
3. release funds after proof or result verification
4. refund after expiry if release conditions are never met

## Scope

This is intentionally narrow:

- Base mainnet only
- canonical USDC only
- standard x402 front door still unchanged
- self-hosted or custom-facilitator path, not default CDP hosted behavior

The goal is to add one solid reserve-release primitive, not a giant generic escrow platform.

## New rail

Use:

- `buildBaseMainnetUsdcReserveReleaseRail(...)`

This advertises a Base rail with:

- `settlementModel: "x402-base-usdc-reserve-release-v2"`
- `facilitatorMode: "evm-reserve-release"`
- `extensions.evm.reserveRelease`

Expected inputs:

- `payTo`
- `amount`
- `escrowContract`

Optional inputs:

- `expirySeconds`
- `reserveMethod`
- `releaseMethod`
- `refundMethod`
- `facilitatorUrl`

## New reserve intent

Use:

- `buildBaseUsdcReserveReleaseIntent(...)`

This keeps the USDC signature flow familiar:

- typed data still uses USDC EIP-3009
- `verifyingContract` remains the USDC token contract
- the signed transfer `to` address becomes the escrow contract

The intent also carries settlement metadata:

- `requestIdHash`
- `paymentIdHash`
- `resultCommitment`
- `reserveExpiryUnix`

That metadata is what lets the facilitator reserve funds first and release them later on proof.

## Release and refund helpers

The package also exposes:

- `buildBaseUsdcReleaseReservationCall(...)`
- `buildBaseUsdcRefundReservationCall(...)`
- `buildReserveReleaseResultCommitment(...)`

These helpers are intentionally small. They exist so the separate app adapter or proof verifier can:

- compute a stable result commitment
- build the eventual release transaction
- build the eventual refund transaction

without re-defining the settlement shape itself.

## Facilitator behavior

The self-hosted EVM facilitator now supports two Base paths:

### v1 exact settlement

- calls USDC `transferWithAuthorization(...)`
- funds move straight to `payTo`

### v2 reserve-release

- calls escrow `reserveExactWithAuthorization(...)`
- funds move into the escrow contract
- `payTo` is recorded as the intended recipient
- later release or refund happens through separate contract calls

That means v2 keeps x402 recognizable while changing the settlement primitive under the hood.

## Suggested contract surface

The facilitator expects an escrow contract with a surface like:

- `reserveExactWithAuthorization(...)`
- `releaseReservedPayment(...)`
- `refundExpiredPayment(...)`

This repo now includes that minimal Base-first contract directly:

- `contracts-evm/X402BaseUSDCReserveEscrow.sol`

It is intentionally small and builds on audited OpenZeppelin primitives:

- `AccessControl`
- `Pausable`
- `ReentrancyGuard`
- `SafeERC20`

The USDC-specific piece is only the EIP-3009 wrapper that pulls funds into escrow with
`transferWithAuthorization(...)` before later release or refund.

## OpenZeppelin wiring

The escrow contract is not a large custom system. It is a narrow x402 wrapper assembled from a few audited OpenZeppelin building blocks plus one USDC-specific reserve step.

### `AccessControl`

Used for operator boundaries:

- `DEFAULT_ADMIN_ROLE`: can manage roles
- `PAUSER_ROLE`: can pause and unpause the escrow
- `RELEASER_ROLE`: can reserve and release payments

Why this matters:

- arbitrary third parties cannot consume a signed USDC authorization
- the hosted or self-hosted facilitator remains the trusted operator that turns an x402 payment into an onchain reserve
- the same operator role performs the later release step after app-level proof or result verification

### `Pausable`

Used as the emergency stop:

- blocks `reserveExactWithAuthorization(...)`
- blocks `releaseReservedPayment(...)`
- blocks `refundExpiredPayment(...)`

Why this matters:

- gives the operator a clean kill switch if the relayer, app adapter, or upstream token integration behaves unexpectedly

### `ReentrancyGuard`

Applied to the reserve, release, and refund entrypoints.

Why this matters:

- the contract moves ERC-20 funds during state transitions
- this keeps the reserve/release/refund flow from becoming reentrancy-sensitive if a future token implementation or wrapper behaves unexpectedly

### `SafeERC20`

Used for the release and refund legs:

- `safeTransfer(payTo, amount)`
- `safeTransfer(payer, amount)`

Why this matters:

- keeps the outbound token transfer path defensive and standard

### Small custom logic on top

The custom x402-specific logic is intentionally narrow:

- record a reservation under `keccak256(requestIdHash, paymentIdHash)`
- bind `payer`, `payTo`, `amount`, `expiry`, and `resultCommitment`
- pull USDC into escrow with `transferWithAuthorization(...)`
- release only if:
  - the reservation exists
  - it is still in `Reserved`
  - the `resultCommitment` matches
  - the reservation has not expired
- refund only if:
  - the reservation exists
  - it is still in `Reserved`
  - the expiry has passed

That is the whole design: OpenZeppelin handles the generic security/control pieces, and the contract adds only the x402 reserve-release semantics.

## Escrow topology

The currently deployed hardened Base Sepolia escrow is:

- `0xc04568674aae8f52f90ecc033c8e05513a26b25e`

Treat that as a shared reference deployment for testing, not a mandatory global singleton.

You have two valid models:

### 1. Shared escrow per network

One escrow contract can serve many apps, agents, or tenants on the same network.

That works because `reserveExactWithAuthorization(...)` records these values per reservation:

- `requestIdHash`
- `paymentIdHash`
- `payer`
- `payTo`
- `amount`
- `resultCommitment`
- `expiry`

So even with one shared escrow:

- each reservation still has its own `payTo`
- each reservation still has its own proof/result binding
- each reservation still has its own expiry and refund path

This is the simplest managed-hosting model.

### 2. Tenant-owned or agent-owned escrow

A developer, tenant, or even a single agent can use a different escrow contract address.

That already works in this repo because the rail and intent builders carry the escrow contract explicitly:

- `buildBaseMainnetUsdcReserveReleaseRail({ escrowContract })`
- `buildBaseUsdcReserveReleaseIntent({ escrowContract })`
- `X402_BASE_SEPOLIA_ESCROW_ADDRESS` for the Sepolia smoke path

This gives stronger isolation if you want:

- one escrow per tenant
- one escrow per app
- one escrow per high-value agent workflow

### Recommended default

For managed hosting, start with:

- one shared escrow per network
- dynamic `payTo` per tenant or app
- relayer and app-level authorization controls above that

For stricter isolation, let advanced tenants bring their own escrow contract later.

## Hosted validation helper

This repo now also exposes:

- `inspectReserveReleaseEscrow(...)`

Use it when a hosted adapter wants to accept a tenant-owned escrow without blindly trusting the submitted contract address.

The helper checks:

- code exists at the escrow address
- `usdc()` matches the expected settlement token when provided
- `RELEASER_ROLE` is granted to the configured releaser when provided
- `PAUSER_ROLE` is granted to the configured pauser when provided

That gives the app-layer onboarding flow one reusable generic validation step before it stores a dedicated escrow in tenant config.

Recommended argument binding:

- `requestIdHash`
- `paymentIdHash`
- `payer`
- `payTo`
- `token`
- `amount`
- `validAfter`
- `validBefore`
- `nonce`
- `resultCommitment`
- `expiry`
- signature parts `v`, `r`, `s`

This is intentionally specific to x402 reserve-release semantics.

## Tooling

Use:

- `pnpm build:evm-contracts`
- `pnpm test`
- `pnpm deploy:base-sepolia-escrow`

The deploy script targets Base Sepolia by default, uses `https://sepolia.base.org` when
`X402_BASE_SEPOLIA_RPC_URL` is not set, and defaults the USDC token to Circle's official
Base Sepolia USDC address.

## Why this matters

This v2 is the bridge between:

- `v1`: pay first, then run work
- `future`: pay for verified result

It gives Base-first services a more credible proof-gated payment model without changing the HTTP/x402 front door and without pretending that a plain offchain authorization already locks funds.
