# zeko-x402

`zeko-x402` is a narrow x402 toolkit for apps that want standard x402 payments on EVM and proof-aware execution on Zeko.

It is the protocol and settlement layer, not the app layer.

## What's In This Repo

- Core x402 helpers: `402 Payment Required`, payment headers, rails, payloads, receipts
- EVM rails: Ethereum and Base USDC exact settlement plus reserve-release flows
- Zeko rail: zkApp settlement helpers, witness store/service, and client helpers
- Self-hosted facilitator: local or hosted `/verify` and `/settle` service for EVM rails
- EVM contracts: reserve-release escrow contracts and Sepolia deploy/smoke scripts
- Docs for hosted adapters, tenant onboarding, and app integration boundaries

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm test
```

## Run Locally

### 1. Start the EVM facilitator

Enable one or both EVM rails:

```bash
X402_EVM_RELAYER_PRIVATE_KEY=0x...
X402_ETHEREUM_RPC_URL=https://ethereum.publicnode.com
X402_ETHEREUM_PAY_TO=0x...
X402_BASE_RPC_URL=https://mainnet.base.org
X402_BASE_PAY_TO=0x...
pnpm evm:facilitator
```

The facilitator listens on `127.0.0.1:7422` by default. Set `X402_EVM_FACILITATOR_HOST=0.0.0.0` for hosted deploys. A simple Render config is included in [`render.yaml`](/Users/evankereiakes/Documents/Codex/zeko-x402/render.yaml).

### 2. Run smokes

Smoke commands use live rails when funded keys are configured. EVM smokes need `X402_EVM_PRIVATE_KEY` for the buyer wallet.

```bash
pnpm smoke:evm-flow
pnpm smoke:ethereum-flow
pnpm smoke:base-sepolia-reserve-release
pnpm smoke:ethereum-sepolia-reserve-release
```

### 3. Run the Zeko path

```bash
pnpm build:zkapp
pnpm smoke:zeko-flow
```

If you want a quick readiness check first:

```bash
pnpm doctor:rails
```

## What Devs Need To Know

- Ethereum and Base are first-class EVM rails.
- x402 stays standard at the payment layer. Zeko is the upgrade layer for privacy, proofs, and release logic.
- This repo is reusable infra: rails, intents, facilitator, contracts, and smokes.
- Use separate relayer and `payTo` wallets in real deployments.
- App-specific onboarding, auth, tenant signup, and workflow gating should live in a separate app or adapter repo.
- For hosted multi-tenant setups, each tenant should bring its own `payTo`, relayer, and optionally dedicated escrow.
- Reserve-release flows exist for proof-gated payments. Exact settlement is still the simplest path.

## Main Commands

- `pnpm test`: run the test suite
- `pnpm evm:facilitator`: start the self-hosted EVM facilitator
- `pnpm doctor:rails`: check EVM and Zeko readiness
- `pnpm build:zkapp`: compile the Zeko zkApp helpers
- `pnpm deploy:base-sepolia-escrow`: deploy Base Sepolia escrow
- `pnpm deploy:ethereum-sepolia-escrow`: deploy Ethereum Sepolia escrow
- `pnpm smoke:multirail-offer`: build a single `402` offer for Ethereum, Base, and Zeko

## Docs

- [EVM hosted and self-hosted flows](/Users/evankereiakes/Documents/Codex/zeko-x402/docs/evm-hosted-facilitators.md)
- [Reserve-release v2/v3/v4](/Users/evankereiakes/Documents/Codex/zeko-x402/docs/evm-reserve-release-v2.md)
- [Multi-rail paid resource](/Users/evankereiakes/Documents/Codex/zeko-x402/docs/multirail-paid-resource.md)
- [Adapter architecture](/Users/evankereiakes/Documents/Codex/zeko-x402/docs/adapter-architecture.md)
- [Tenant onboarding](/Users/evankereiakes/Documents/Codex/zeko-x402/docs/tenant-onboarding.md)
- [OpenClaw app handoff](/Users/evankereiakes/Documents/Codex/zeko-x402/docs/openclaw-agent-handoff.md)
