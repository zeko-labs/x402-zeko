# Tempo And Arc Payout Options

This note records the current integration posture for adding Tempo and Arc as x402 payout chains.

## Bottom Line

`zeko-x402` can advertise any EVM chain using CAIP-2 network ids such as `eip155:4217`. The package now exposes generic custom EVM EIP-3009 builders for emerging USDC-like payout chains, but Tempo and Arc should stay behind explicit self-hosted or custom facilitator configuration until their live token authorization behavior is verified.

Ethereum and Base remain the verified first-class production rails in this repo. Tempo and Arc are candidate payout rails.

## What Is Known

Tempo mainnet currently has an official token list entry for chain id `4217`. The USDC-like asset in that list is `USDC.e` at `0x20c000000000000000000000b9537d11c60e8b50` with 6 decimals. Treat that as the default Tempo USDC-like payout token for experiments, not as verified native Circle USDC.

Arc official docs currently publish Arc Testnet connection details:

- Network id: `eip155:5042002`
- RPC: `https://rpc.testnet.arc.network/`
- Native gas symbol: `USDC`
- Testnet USDC contract: `0x3600000000000000000000000000000000000000`

Arc mainnet should not be hardcoded here until official mainnet chain id, RPC, explorer, token address, and token authorization method are published and verified.

The `arc_agent_nanopayments` repo is helpful as an app-layer pattern: Zeko proof completion triggers an app-mediated Arc settlement or relay. It is not a drop-in x402 facilitator implementation.

## What Belongs In `zeko-x402`

- CAIP-2 EVM network handling.
- Generic custom EVM rail and intent builders.
- Hosted and self-hosted facilitator configuration for explicit network ids.
- Protocol-shaped receipt, offer, idempotency, proof condition, and settlement metadata.
- Tests proving custom EVM rails do not need special-casing at the x402 layer.

## What Belongs In The App Or Adapter

- Whether Tempo or Arc is offered to a given tenant.
- Seller pricing, fees, minimums, and payout policy.
- Zeko proof completion watching and release/refund policy.
- Arc-specific Circle Gateway or nanopayment relay calls.
- Any non-EIP-3009 settlement path such as Permit2, EIP-2612, or a chain-specific gateway contract.

## Custom EVM Smoke Path

For a custom EVM EIP-3009-compatible token:

```bash
X402_EVM_NETWORK=eip155:4217 \
X402_EVM_CHAIN_NAME=Tempo \
X402_EVM_TOKEN_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50 \
X402_EVM_TOKEN_SYMBOL=USDC.e \
X402_EVM_TOKEN_DECIMALS=6 \
X402_EVM_EIP712_NAME=replace_with_verified_tempo_usdc_eip712_name \
X402_EVM_RPC_URL=https://your-tempo-rpc \
X402_EVM_RELAYER_PRIVATE_KEY=0x... \
X402_EVM_PRIVATE_KEY=0x... \
X402_EVM_PAY_TO=0x... \
pnpm smoke:evm-flow
```

The convenience Tempo selector uses the current Tempo token-list USDC.e address:

```bash
X402_EVM_NETWORK=tempo \
X402_TEMPO_EIP712_NAME=replace_with_verified_tempo_usdc_eip712_name \
X402_TEMPO_RPC_URL=https://your-tempo-rpc \
X402_TEMPO_RELAYER_PRIVATE_KEY=0x... \
X402_EVM_PRIVATE_KEY=0x... \
X402_TEMPO_PAY_TO=0x... \
pnpm smoke:evm-flow
```

The Arc selector is intentionally testnet-only until Arc mainnet details are official:

```bash
X402_EVM_NETWORK=arc-testnet \
X402_ARC_EIP712_NAME=replace_with_verified_arc_usdc_eip712_name \
X402_ARC_RPC_URL=https://rpc.testnet.arc.network/ \
X402_ARC_RELAYER_PRIVATE_KEY=0x... \
X402_EVM_PRIVATE_KEY=0x... \
X402_ARC_PAY_TO=0x... \
pnpm smoke:evm-flow
```

These smokes assume the token supports `authorizationState(...)` and `transferWithAuthorization(...)`. If the chain's USDC path is Permit2, EIP-2612, or Circle Gateway based, the right next step is a new generic x402 V2 settlement adapter rather than pretending the EIP-3009 facilitator can settle it.

## Production Checklist

- Confirm official chain id, RPC, explorer, and native USDC contract.
- Probe the token ABI for `authorizationState` and `transferWithAuthorization`.
- Confirm EIP-712 domain name and version by reading the token or official docs.
- Run a funded exact-settlement smoke through the self-hosted facilitator.
- If EIP-3009 is unavailable, implement the Permit2, EIP-2612, or gateway settlement path before advertising it as a live payout rail.
