# EVM Facilitators

`zeko-x402` now treats Base and Ethereum mainnet as separate EVM product paths, with either hosted or self-hosted settlement.

## Base

Base is the default hosted-facilitator path.

- Rail builder: `buildBaseMainnetUsdcRail(...)`
- Intent builder: `buildBaseUsdcExactEip3009Intent(...)`
- Hosted client: `CDPFacilitatorClient`
- Self-hosted client: `SelfHostedEvmFacilitator`
- Smoke runner: `pnpm smoke:evm-flow` with `X402_EVM_NETWORK=base`

This is the “works like normal x402 on Coinbase/Base” path.

## Ethereum mainnet

Ethereum mainnet is also a first-class rail in the package, but it is not treated as part of the default CDP facilitator set.

- Rail builder: `buildEthereumMainnetUsdcRail(...)`
- Intent builder: `buildEthereumMainnetUsdcExactEip3009Intent(...)`
- Hosted client: `HostedX402FacilitatorClient`
- Self-hosted client: `SelfHostedEvmFacilitator`
- Smoke runner: `pnpm smoke:evm-flow` with `X402_EVM_NETWORK=ethereum`

The important difference is operational:

- Base can default to the hosted CDP facilitator.
- Ethereum mainnet currently needs `X402_EVM_FACILITATOR_URL` pointing at a compatible hosted/self-managed facilitator.

## Self-hosted relayer

The package now includes a self-hosted EVM facilitator that verifies the signed EIP-3009 payload locally and relays `transferWithAuthorization(...)` to the live USDC contract.

- Server script: `pnpm evm:facilitator`
- In-process smoke fallback: `pnpm smoke:evm-flow` with `X402_EVM_RPC_URL` plus `X402_EVM_RELAYER_PRIVATE_KEY`
- HTTP mode: set `X402_EVM_FACILITATOR_URL=http://127.0.0.1:7422`
- Dedicated Ethereum smoke: `pnpm smoke:ethereum-flow`

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

Prefer `X402_BASE_PAY_TO`, `X402_ETHEREUM_PAY_TO`, or `X402_EVM_PAY_TO`. Older legacy aliases are only kept for backward compatibility. In production, keep `payTo` separate from the relayer wallet.

Ethereum example:

```bash
X402_ETHEREUM_RPC_URL=https://... \
X402_ETHEREUM_PAY_TO=0x1111111111111111111111111111111111111111 \
pnpm smoke:ethereum-flow
```

## Why this split matters

This keeps interoperability simple:

- EVM users still see the normal x402-style payment experience.
- Base users can use the default Coinbase/CDP-style flow or a self-hosted relayer.
- Ethereum users can still choose L1 without pretending the default CDP facilitator already supports it.

That means we can offer both choices honestly while still keeping Zeko as the place where we add stronger verified-result and privacy properties.
