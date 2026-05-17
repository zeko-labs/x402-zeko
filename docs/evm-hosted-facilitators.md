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

## Emerging EVM payout chains

The package also exposes custom EVM EIP-3009 rail builders for candidate payout chains such as Tempo and Arc. Use these only when the chain id, token address, token decimals, EIP-712 domain, and `transferWithAuthorization(...)` support have been verified.

- Generic rail builder: `buildCustomEvmExactEip3009Rail(...)`
- Generic intent builder: `buildCustomEvmExactEip3009Intent(...)`
- Tempo smoke shortcut: `pnpm smoke:tempo-flow`
- Arc Testnet smoke shortcut: `pnpm smoke:arc-testnet-flow`

Tempo currently uses a custom/self-hosted facilitator path. Arc is testnet-only in this repo until official mainnet details are published. For Arc nanopayments, Circle's reference architecture uses Circle Gateway batching with x402 and local EIP-3009 authorizations, so the direct self-hosted EIP-3009 smoke should be treated as a compatibility check rather than the recommended production Arc payment flow.

## Self-hosted relayer

The package now includes a self-hosted EVM facilitator that verifies the signed EIP-3009 payload locally and relays `transferWithAuthorization(...)` to the live USDC contract.

- Server script: `pnpm evm:facilitator`
- In-process smoke fallback: `pnpm smoke:evm-flow` with `X402_EVM_RPC_URL` plus `X402_EVM_RELAYER_PRIVATE_KEY`
- HTTP mode: set `X402_EVM_FACILITATOR_URL=http://127.0.0.1:7422`
- Dedicated Ethereum smoke: `pnpm smoke:ethereum-flow`

Self-hosted means the app owns verification and relaying. It still needs EVM RPC access because the relayer must read USDC balance/authorization state and submit the settlement transaction. For hosted production, configure a private or dedicated HTTPS RPC as the first entry in `X402_BASE_RPC_URLS` or `X402_ETHEREUM_RPC_URLS`; keep public RPCs only as fallbacks. The facilitator refuses hosted startup when it only has one known shared public RPC unless `X402_EVM_ALLOW_SHARED_PUBLIC_RPC=true` is set for a local experiment.

On Render, set `X402_EVM_FACILITATOR_HOST=0.0.0.0` and leave `X402_EVM_FACILITATOR_PORT` unset unless you also set Render's `PORT`. The server will use Render's injected `PORT` automatically. For Base mainnet, the minimum production RPC shape is:

```bash
X402_BASE_RPC_URLS=https://your-private-base-rpc
```

An optional public fallback is fine after the private URL:

```bash
X402_BASE_RPC_URLS=https://your-private-base-rpc,https://mainnet.base.org
```

Read-only RPC calls and receipt polling use conservative built-in retry/backoff for transient failures such as `429`, rate limits, timeouts, and `502/503/504` responses. Writes are not blindly retried after broadcast because an ambiguous `eth_sendRawTransaction` response may already have submitted the transaction.

## HTTP API shape

Hosted facilitators expose:

- `GET /health` and `GET /version` for version metadata.
- `GET /supported` for network and redacted RPC configuration.
- `GET /docs` for a human-readable route and payload summary.
- `GET /openapi.json` for a machine-readable OpenAPI document.
- `POST /verify` for signed EVM x402 payment verification.
- `POST /settle` for signed EVM x402 payment settlement.

Both `/verify` and `/settle` expect:

```json
{
  "paymentPayload": {
    "protocol": "x402",
    "networkId": "eip155:8453",
    "settlementRail": "evm",
    "payTo": "0x...",
    "accepted": {
      "asset": "0x...",
      "amount": "250000"
    },
    "payload": {
      "authorization": "EIP-3009 typed-data authorization envelope"
    }
  },
  "paymentRequirements": {
    "accepts": []
  }
}
```

Do not post the advertised payment requirements object as `paymentPayload`. Validation errors return HTTP 400 with `errorCode: "invalid_request"` and a specific message such as `paymentPayload.accepted.asset is required.`

## Amount units

By default, hosted facilitator clients treat advertised EVM x402 `amount` values as decimal token amounts and convert them to atomic token units using the asset decimals.

Some platforms, including SantaClawz, advertise EVM payment requirements with atomic token units already. Those requirements must include:

```json
{
  "extensions": {
    "evm": {
      "amountUnit": "atomic"
    }
  }
}
```

When `amountUnit` is `atomic`, `amount: "250000"` means 250,000 USDC minor units, or `$0.25` for a 6-decimal USDC token. The hosted facilitator client must not convert it again. Fee-split fields such as `grossAmount`, `sellerAmount`, and `protocolFeeAmount` are always atomic unit strings.

## Relayer scaling

The self-hosted facilitator keeps the single-instance path simple: settlements are serialized in-process per `{ networkId, relayer }`, then the facilitator fetches the pending nonce and broadcasts. That is enough for one service instance per relayer wallet.

If a hosted deployment runs multiple replicas that all share one relayer wallet, configure an external relayer lock. The existing in-process queue stays in place, but each settlement also acquires the external lock before pending nonce allocation and transaction broadcast.

```bash
X402_EVM_RELAYER_LOCK_URL=https://your-lock-service.example/x402-relayer-lock
X402_EVM_RELAYER_LOCK_BEARER_TOKEN=replace_with_lock_service_token
X402_EVM_RELAYER_LOCK_TTL_MS=600000
X402_EVM_RELAYER_LOCK_RENEW_INTERVAL_MS=60000
X402_EVM_RELAYER_LOCK_ACQUIRE_TIMEOUT_MS=15000
```

Hosted startup requires `X402_EVM_RELAYER_LOCK_BEARER_TOKEN` when `X402_EVM_RELAYER_LOCK_URL` is configured. Keep the lock service private and authenticated; an unauthenticated shared-relayer lock can be abused as a denial-of-service lever. For a private local experiment only, `X402_EVM_ALLOW_UNAUTHENTICATED_RELAYER_LOCK=true` bypasses this startup guard.

The lock service needs three JSON endpoints:

- `POST /acquire` with `{ key, owner, ttlMs, context }`, returning `{ acquired: true, lockId }` when the lock is held.
- `POST /renew` with `{ key, owner, lockId, ttlMs, context }`, atomically extending the same owner/lock lease and returning `{ renewed: true, lockId }`.
- `POST /release` with `{ key, owner, lockId, context }`, releasing the lock or letting the TTL expire if the caller crashes.

The lock key is `networkId:relayerAddress`. The backend must make acquire/renew/release atomic, for example with Redis `SET NX PX` plus token-checked renew/release, or a database lock with an expiry column and owner token. Use one replica per relayer, different relayer wallets per replica, or this external lock. Do not run multiple replicas against the same relayer wallet without one of those protections.

Set `X402_EVM_RELAYER_LOCK_TTL_MS` above the worst-case settlement plus receipt wait time for the slowest enabled chain. The facilitator renews the lease every `X402_EVM_RELAYER_LOCK_RENEW_INTERVAL_MS` while a settlement is in progress; set the interval lower than the TTL, typically around one-third of the TTL.

Ethereum example:

```bash
X402_ETHEREUM_RPC_URLS=https://your-private-ethereum-rpc,https://ethereum.publicnode.com \
X402_ETHEREUM_PAY_TO=0x1111111111111111111111111111111111111111 \
pnpm smoke:ethereum-flow
```

Base example:

```bash
X402_BASE_RPC_URLS=https://your-private-base-rpc,https://mainnet.base.org \
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
