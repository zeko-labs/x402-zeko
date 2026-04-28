# OpenClaw Agent App Handoff

This doc is the application-layer handoff for building an OpenClaw agent product on top of `zeko-x402`.

The intended product is:

- a private OpenClaw agent or workflow runs on Zeko
- the agent can charge through standard x402 rails
- Base mainnet USDC is the default payment path
- Ethereum mainnet USDC is an optional compatibility rail
- Zeko-native settlement can remain optional

This doc is deliberately app-specific. It explains what the separate OpenClaw app or adapter repo should build, what should stay in `zeko-x402`, how hosting should work, and how the developer signup flow should feel.

## Product Thesis

The OpenClaw app should not present itself as a new payment protocol.

It should present itself as:

- a private agent app on Zeko
- with standard x402 payments on Base and Ethereum
- plus optional proof-gated release logic for higher-trust jobs

The key idea is that the payment surface stays familiar, while the work layer becomes more private, more verifiable, and eventually more automatable.

## What Stays In `zeko-x402`

Keep these concerns in this repo:

- x402 header and payload construction
- Base and Ethereum rail builders
- Zeko rail builders
- EVM facilitator logic
- reserve-release v2 helpers
- escrow inspection helpers
- settlement receipts and verification helpers

Rule of thumb:

- if another app could reuse it, it belongs here
- if it depends on OpenClaw concepts like agents, sessions, capabilities, or workflow UI, it does not

## What Belongs In The OpenClaw App Repo

Build these concerns in the OpenClaw app or adapter layer:

- agent registration
- developer onboarding
- tenant account and API key management
- pricing configuration
- route handlers for paid work
- binding one successful payment to one unit of agent work
- result formatting and app-specific receipts
- ownership proof UX for `payTo` and relayer wallets
- relayer custody UX
- hosted vs self-hosted mode selection

The OpenClaw app is the developer product. `zeko-x402` is the settlement toolkit underneath it.

## Recommended Architecture

There are four layers.

### 1. OpenClaw app layer

This is the user-facing product:

- dashboard
- signup flow
- agent configuration
- pricing controls
- developer API surface

This layer decides:

- what an agent is
- what a paid task is
- how a result is returned
- how one payment maps to one work unit

### 2. x402 negotiation layer

This layer lives in the app backend but uses `zeko-x402`.

It is responsible for:

- building `402 Payment Required`
- offering Base by default
- optionally offering Ethereum
- optionally offering a Zeko-native rail later
- verifying incoming x402 payment payloads

This is still standard x402.

### 3. Zeko work and proof layer

This is where the OpenClaw private workflow actually runs.

It is responsible for:

- executing the private agent task
- producing a result
- optionally producing a proof or committed result digest
- deciding whether a reserve-release payment should be released or refunded

This layer is why the stack exists. It is the upgrade layer.

### 4. Settlement orchestration layer

This layer bridges the first two.

It is responsible for:

- exact EVM settlement for simple jobs
- reserve-release orchestration for proof-gated jobs
- calling release or refund helpers after the Zeko workflow reaches an outcome

This is where the app uses `zeko-x402` but still applies OpenClaw-specific business logic.

## Two Payment Modes

The OpenClaw app should support two payment modes, even if only one is enabled by default at launch.

### Mode A: Settle-first

Flow:

1. user requests paid agent work
2. app returns `402 Payment Required`
3. client pays on Base or Ethereum
4. payment settles immediately
5. app runs the agent task
6. app returns result and settlement receipt

Use this when:

- the job is low risk
- instant compatibility matters more than proof gating
- you want the simplest possible launch path

This should likely be the initial default.

### Mode B: Reserve-release

Flow:

1. user requests paid agent work
2. app returns `402 Payment Required`
3. client authorizes a reserve-release payment
4. funds move into escrow
5. agent task runs on Zeko
6. proof or result commitment is produced
7. app releases funds or refunds on expiry

Use this when:

- the job is expensive
- the result matters more than instant settlement
- the product wants a proof-aware economic model

This should be the upgrade path for higher-trust tasks.

Important note:

- Base reserve-release v2 is the concrete deployed and proven proof-gated path today
- Ethereum reserve-release is now available in the codebase too, but should still be treated as the next live rollout rather than the default
- Ethereum should remain a compatibility rail first

## Recommended Launch Shape

For the first real OpenClaw release:

- Base mainnet USDC should be the default rail
- Ethereum mainnet USDC should be opt-in
- Zeko-native settlement should be behind a feature flag
- reserve-release v2 should be enabled for higher-value or proof-gated tasks

That gives the app a clean story:

- familiar payment rails
- private Zeko execution
- an obvious path toward proof-backed automation

## Hosting Recommendation

The hosted product should be split into two concerns.

### Hosted OpenClaw control plane

This is the main app service. It should host:

- signup and dashboard
- tenant config
- agent registration
- pricing and rail configuration
- paid endpoint issuance
- payment verification and settlement orchestration

This is the default hosted product surface for developers.

### Hosted facilitator path

This can be part of the same deployment or a sibling service.

It should host:

- `/health`
- `/supported`
- `/verify`
- `/settle`

If the app launches with one hosted service only, this can live inside the main OpenClaw backend. It does not need to be a separately branded product on day one.

### Zeko workflow services

The private workflow runtime, witness services, and optional Zeko-native settlement helpers can remain separate internal services. They do not need to be exposed to end users as independent products.

## Managed vs Self-Hosted

The app should support three operating modes in the UI.

### 1. Managed Default

The platform hosts:

- x402 control plane
- facilitator
- release orchestration

The developer provides:

- `payTo`
- relayer
- gas funding

This is the easiest onboarding path and should be the default.

### 2. Dedicated Escrow

The platform still hosts the app, but the developer also registers a dedicated escrow contract.

Use this when:

- the developer wants better isolation
- the jobs are higher value
- the developer does not want to share a network-level escrow deployment

The OpenClaw app should validate that escrow before activation using `inspectReserveReleaseEscrow(...)`.

### 3. Self-Hosted

The developer runs their own settlement path and possibly their own full app backend.

Use this when:

- the developer wants maximum control
- the developer does not want to trust hosted relayer infrastructure
- the developer wants fully custom routing or custody

The OpenClaw app can still offer this mode, but it should not be the primary onboarding path.

## UI Signup Flow

The developer signup and setup experience should be explicit and opinionated.

### Screen 1: Create project

Collect:

- project name
- agent or workflow name
- contact email

Explain:

- private work runs on Zeko
- Base is the default payment rail
- Ethereum can be enabled later or immediately

### Screen 2: Choose operating model

Offer:

- Managed Default
- Dedicated Escrow
- Self-Hosted

Each option should have one-sentence tradeoff copy:

- Managed Default: fastest setup, shared hosted infrastructure
- Dedicated Escrow: more setup, more isolation
- Self-Hosted: maximum control, maximum ops

### Screen 3: Register `payTo`

Collect:

- Base `payTo`
- optional Ethereum `payTo`

Recommended UX:

- paste wallet address
- sign a message proving ownership
- show the stored verified address after success

### Screen 4: Register relayer

Offer:

- managed relayer key upload
- external signer or relayer endpoint

Explain clearly:

- relayer pays gas
- `payTo` receives funds
- they should not usually be the same production wallet

If using managed relayer custody:

- show the exact wallet address to fund
- show network-specific gas requirements

### Screen 5: Escrow setup

For Managed Default:

- explain that the app uses the platform’s shared escrow for Base reserve-release jobs

For Dedicated Escrow:

- collect escrow contract address
- inspect it with `inspectReserveReleaseEscrow(...)`
- verify token, role grants, and code presence
- only allow activation after inspection passes

### Screen 6: Pricing and payment mode

Collect:

- price per task or capability
- default rail
- whether a task is settle-first or reserve-release

Good launch UX:

- Base settle-first as default
- reserve-release available behind an advanced toggle

### Screen 7: Test payment

Offer:

- generate a test paid endpoint
- run a test `402`
- show successful payment and receipt
- show whether the task used settle-first or reserve-release mode

This should be the moment where the developer sees the whole product click.

## Required Stored Tenant Model

At minimum, the OpenClaw app should store:

- `tenantId`
- `projectId`
- `apiKey`
- `defaultNetwork`
- `allowedRails`
- `pricing`
- `base.payTo`
- `base.relayer`
- optional `base.escrowContract`
- optional `ethereum.payTo`
- optional `ethereum.relayer`
- operating model
- release mode per task class

For proof-gated tasks, also store:

- result commitment policy
- expiry policy
- refund policy

## Suggested API Shape

The app backend can expose:

- `POST /projects`
- `POST /projects/:id/payto`
- `POST /projects/:id/relayer`
- `POST /projects/:id/escrow/inspect`
- `POST /projects/:id/escrow/register`
- `POST /projects/:id/pricing`
- `POST /projects/:id/rails`
- `POST /projects/:id/test-payment`

For runtime traffic, the important route is the paid work endpoint:

- `POST /agents/:agentId/run`

Behavior:

- if unpaid, return `402 Payment Required`
- if paid or reserved successfully, run work
- if proof-gated, wait for proof outcome before release
- return result plus payment receipt

## What The OpenClaw App Should Not Do

Do not:

- re-implement x402 payload rules
- allow arbitrary escrow addresses per request
- relay arbitrary third-party payments without tenant registration
- merge `payTo` and relayer concepts in the UI
- make Zeko-native settlement mandatory at launch

Those choices would either blur trust boundaries or make the first release harder than it needs to be.

## Final Recommendation

The right first product is:

- a managed OpenClaw app
- Base-first x402 by default
- Ethereum optional
- private work on Zeko
- reserve-release available for higher-trust jobs
- developer-provided `payTo`, relayer, and optional dedicated escrow

That gives OpenClaw a very strong launch story:

- standard payments
- private execution
- proof-aware release logic
- a credible path toward paid agents that are more private, more verifiable, and more automatable than EVM-only x402 flows
