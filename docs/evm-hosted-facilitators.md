# EVM Facilitators

`zeko-x402` treats Ethereum and Base mainnet as first-class EVM rails, with either hosted or self-hosted settlement.

## Ethereum mainnet

Ethereum mainnet is a first-class rail in the package.

- Rail builder: `buildEthereumMainnetUsdcRail(...)`
- Intent builder: `buildEthereumMainnetUsdcExactEip3009Intent(...)`
- Hosted client: `HostedX402FacilitatorClient`
- Self-hosted client: `SelfHostedEvmFacilitator`
- Smoke runner: `pnpm smoke:evm-flow` with `X402_EVM_NETWORK=ethereum`

The important difference is operational:

- Ethereum mainnet uses a compatible hosted facilitator or the built-in self-hosted relayer path.

## Base

- Rail builder: `buildBaseMainnetUsdcRail(...)`
- Intent builder: `buildBaseUsdcExactEip3009Intent(...)`
- Hosted client: `CDPFacilitatorClient`
- Self-hosted client: `SelfHostedEvmFacilitator`
- Smoke runner: `pnpm smoke:evm-flow` with `X402_EVM_NETWORK=base`

Base can use the default CDP facilitator path or the built-in self-hosted relayer path.

## Self-hosted relayer

The package now includes a self-hosted EVM facilitator that verifies the signed EIP-3009 payload locally and relays `transferWithAuthorization(...)` to the live USDC contract.

- Server script: `pnpm evm:facilitator`
- In-process smoke fallback: `pnpm smoke:evm-flow` with `X402_EVM_RPC_URL` plus `X402_EVM_RELAYER_PRIVATE_KEY`
- HTTP mode: set `X402_EVM_FACILITATOR_URL=http://127.0.0.1:7422`
- Dedicated Ethereum smoke: `pnpm smoke:ethereum-flow`

Ethereum example:

```bash
X402_ETHEREUM_RPC_URL=https://... \
X402_ETHEREUM_PAY_TO=0x1111111111111111111111111111111111111111 \
pnpm smoke:ethereum-flow
```

Base example:

```bash
X402_BASE_RPC_URL=https://... \
X402_EVM_RELAYER_PRIVATE_KEY=0x... \
pnpm evm:facilitator
```

```bash
X402_EVM_NETWORK=base \
X402_EVM_PRIVATE_KEY=0x... \
X402_BASE_PAY_TO=0x1111111111111111111111111111111111111111 \
X402_EVM_FACILITATOR_URL=http://127.0.0.1:7422 \
pnpm smoke:evm-flow
```

Prefer `X402_ETHEREUM_PAY_TO`, `X402_BASE_PAY_TO`, or `X402_EVM_PAY_TO`. Older legacy aliases are only kept for backward compatibility. In production, keep `payTo` separate from the relayer wallet.

## Why this split matters

This keeps interoperability simple:

- EVM users still see the normal x402-style payment experience.
- Ethereum users can use L1 through a compatible hosted facilitator or the self-hosted relayer.
- Base users can use the CDP-style hosted flow or the self-hosted relayer.

That means we can offer both choices honestly while still keeping Zeko as the place where we add stronger verified-result and privacy properties.
