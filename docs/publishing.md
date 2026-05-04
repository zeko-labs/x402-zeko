# Publishing Checklist

`zeko-x402` has two release surfaces:

1. the npm package
2. the hosted x402 facilitator / paid-resource service

## NPM package

Before `npm publish`, make sure:

- `.env` is local-only and not committed
- real buyer / relayer / payTo keys live in a secret manager or encrypted local keyring
- `pnpm test` passes
- `pnpm pack:dry-run` shows only the files you want to ship

The package now whitelists publishable files through `package.json#files`, so local `.env`, `node_modules`, tests, and local state should not be published.

## Hosted release

For a real x402-compatible launch, you also need a public HTTPS service that exposes:

- an x402 `402 Payment Required` resource
- `/verify` and `/settle` behavior, either directly or behind your facilitator
- health checks and logs for the relayer path

Recommended production shape:

- buyer wallet signs the authorization
- relayer wallet pays gas
- `payTo` receives funds

## Hosted vs self-hosted facilitator

Use a hosted facilitator when the network you want is already supported by your provider and you are comfortable delegating settlement operations.

Use the self-hosted facilitator in this repo when:

- you want one operator-controlled path for Ethereum and Base
- you need Ethereum mainnet today without waiting for a managed provider
- you want Zeko and EVM rails under one deployment boundary

The included `render.yaml` is enough to run the EVM facilitator as a Render web service. The server already exposes:

- `GET /health`
- `GET /supported`
- `POST /verify`
- `POST /settle`

Recommended Render setup:

- keep `X402_EVM_FACILITATOR_HOST=0.0.0.0`
- store relayer keys and RPC URLs as Render secrets, not in repo files
- set `X402_BASE_PAY_TO` and `X402_ETHEREUM_PAY_TO` to your production receiving wallet
- keep the relayer wallet separate from `payTo`

## Key manager

Use the local key manager to generate or import wallets into an encrypted keyring:

```bash
X402_KEY_MANAGER_PASSPHRASE=choose-a-passphrase \
pnpm key-manager generate evm --name payto --json
```

Then export env assignments for the role you want:

```bash
X402_KEY_MANAGER_PASSPHRASE=choose-a-passphrase \
pnpm key-manager export-env --name payto --role payto
```

Supported roles:

- `buyer`
- `relayer`
- `payto`
- `zeko-payer`
- `zeko-beneficiary`
