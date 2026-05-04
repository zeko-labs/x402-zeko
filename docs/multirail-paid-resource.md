# Multi-Rail Paid Resource

The recommended shape for a Zeko-backed x402 service is one `402 Payment Required` response that advertises multiple `accepts` options:

1. Ethereum mainnet USDC as a first-class EVM rail.
2. Base mainnet USDC as a first-class EVM rail.
3. Zeko settlement-contract rail alongside them, so the same resource can offer a ZK-native path without forking the front door.

The standalone script for this is:

```bash
X402_EVM_PAY_TO=0x1111111111111111111111111111111111111111 \
X402_ZKAPP_PUBLIC_KEY=B62q... \
pnpm smoke:multirail-offer
```

Behavior:

- If `X402_INCLUDE_ETHEREUM=true`, Ethereum mainnet is added, using `X402_ETHEREUM_PAY_TO`, `X402_EVM_PAY_TO`, or falling back to the Base `payTo`.
- If `X402_BASE_PAY_TO` or `X402_EVM_PAY_TO` is present, Base is added too.
- If `X402_ZKAPP_PUBLIC_KEY` is present, the script adds the Zeko zkApp rail.
- If the Zeko beneficiary is not provided explicitly, the script reads it from the deployed settlement contract on Zeko testnet.

This keeps the front door boring and compatible:

- standard x402 `402 Payment Required`
- one `PAYMENT-REQUIRED` header
- multiple rails in `accepts`

Then the service can let the client choose:

- the normal Ethereum/EVM path
- the normal Base/EVM path
- the Zeko/ZK path

That separation is deliberate. Compatibility comes from the HTTP/x402 layer, while differentiation comes from the Zeko rail and whatever verified-result or privacy extensions sit behind it.
