# Hosted Tenant Onboarding

This doc describes the app-level registration flow for a hosted service built on top of `zeko-x402`.

It is intentionally generic. The first use case in mind is a private workflow or agent that runs on Zeko while accepting x402 payments on Ethereum or Base, but the onboarding model here should work for any app-specific adapter repo.

## Goal

Keep `zeko-x402` protocol-compatible and self-hostable, while making it easy for a separate hosted adapter to onboard developers safely.

That means:

- no x402 wire-format changes
- no shared gas pool for arbitrary strangers
- dynamic `payTo` per tenant
- optional dedicated escrow per tenant
- a clear toggle between hosted trust models

## Operating Models

The app should offer three modes.

### 1. Managed Default

Use:

- shared network escrow
- tenant-specific `payTo`
- tenant-specific relayer

This is the easiest hosted path.

Tradeoff:

- simplest onboarding
- shared escrow trust boundary
- lowest deployment overhead

### 2. Dedicated Escrow

Use:

- tenant-specific `payTo`
- tenant-specific relayer
- tenant-owned escrow contract

This is the best managed option for higher-value apps or stricter isolation.

Tradeoff:

- more setup
- better blast-radius isolation
- tenant must deploy or register an escrow

### 3. Self-Hosted

Use:

- tenant runs the facilitator
- tenant runs or chooses the escrow
- hosted adapter only points at tenant infrastructure or skips hosted settlement entirely

Tradeoff:

- maximum control
- maximum operational burden

## What The App Should Collect

All modes should collect:

- `tenantId`
- `apiKey` or equivalent app auth
- `defaultNetwork`
- allowed rails
- pricing policy
- `payTo`

Managed modes should also collect, per enabled EVM network:

- relayer address
- relayer funding status
- relayer mode:
  - managed private key
  - external signer / relayer endpoint

Dedicated-escrow mode should additionally collect:

- `escrowContract`
- optional `pauserAddress`
- expected settlement token

## What `zeko-x402` Should Validate

The reusable generic checks belong in this repo, not in the app adapter.

Use `inspectReserveReleaseEscrow(...)` to validate a tenant-owned reserve-release escrow before accepting it for hosted use.

It checks:

- contract code exists at the address
- the contract exposes `usdc()`
- the token matches the expected settlement token, if provided
- the contract grants `RELEASER_ROLE` to the configured releaser, if provided
- the contract grants `PAUSER_ROLE` to the configured pauser, if provided

Example:

```js
import { inspectReserveReleaseEscrow } from "zeko-x402";

const inspection = await inspectReserveReleaseEscrow({
  publicClient,
  escrowAddress: tenant.base.escrowContract,
  expectedTokenAddress: baseUsdcAddress,
  releaserAddress: tenant.base.relayerAddress,
  pauserAddress: platformPauseOperator
});

if (!inspection.ok) {
  throw new Error(`Escrow registration failed: ${inspection.inspectionErrors.join("; ")}`);
}
```

## What The App Adapter Should Validate

The app-specific adapter repo should own:

- API key creation and rotation
- wallet ownership proof policy
- relayer-key storage policy
- funding prompts and UX
- tenant quotas, billing, and rate limits
- app-specific work routing

This is where a UI toggle belongs:

- `Managed Default`
- `Dedicated Escrow`
- `Self-Hosted`

The toggle should explain risk clearly:

- shared escrow is easiest
- dedicated escrow is more isolated
- self-hosted gives the tenant full control

## Recommended Registration Flow

1. Choose operating model.
2. Register `payTo`.
3. Register a relayer or external signer endpoint.
4. If using dedicated escrow, validate and register the escrow.
5. Show the exact wallets that need gas funding.
6. Save tenant config.
7. Start issuing paid x402 resources.

## Suggested Hosted API Shape

The adapter repo can expose a small control-plane API like:

- `POST /tenants`
- `POST /tenants/:tenantId/networks/base`
- `POST /tenants/:tenantId/networks/ethereum`
- `POST /tenants/:tenantId/escrow/inspect`
- `POST /tenants/:tenantId/escrow/register`
- `POST /tenants/:tenantId/rails`

The app-specific adapter can also expose an admin flow that runs a dry inspection first and only saves the escrow if inspection passes.

## Important Safety Rule

Do not allow arbitrary escrow contracts to be passed on each payment request.

Instead:

- register the escrow once per tenant
- validate it up front
- store it in tenant config
- use that stored address when building rails and reserve intents

That keeps the hosted service from becoming a gas relay for untrusted arbitrary contracts.

## What Still Does Not Change

Even with tenant-owned escrow, the x402 protocol stays the same:

- `402 Payment Required`
- `PAYMENT-REQUIRED`
- `PAYMENT-SIGNATURE`
- `PAYMENT-RESPONSE`

Only the service-layer configuration changes:

- which `payTo` is used
- which relayer is used
- which escrow is used
- what workflow gets unlocked after payment
