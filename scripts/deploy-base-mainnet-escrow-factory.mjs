import { base } from "viem/chains";

import { deployEscrowV4Factory, optionalEnv, requiredEnv } from "./lib/deploy-escrow-v4.mjs";

const OFFICIAL_BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const rpcUrl = optionalEnv("X402_BASE_MAINNET_RPC_URL") ?? "https://mainnet.base.org";
const deployerPrivateKey =
  optionalEnv(
    "X402_BASE_MAINNET_DEPLOYER_PRIVATE_KEY",
    "X402_BASE_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ) ?? requiredEnv("X402_BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
const usdcAddress = optionalEnv("X402_BASE_MAINNET_USDC_ADDRESS") ?? OFFICIAL_BASE_MAINNET_USDC;
const adminAddress =
  optionalEnv("X402_BASE_MAINNET_ESCROW_FACTORY_ADMIN", "X402_BASE_MAINNET_ESCROW_ADMIN") ??
  requiredEnv("X402_BASE_MAINNET_ESCROW_FACTORY_ADMIN");
const creatorAddress =
  optionalEnv("X402_BASE_MAINNET_ESCROW_FACTORY_CREATOR", "X402_BASE_MAINNET_ESCROW_RELEASER") ??
  requiredEnv("X402_BASE_MAINNET_ESCROW_FACTORY_CREATOR");

await deployEscrowV4Factory({
  network: "base-mainnet",
  chain: base,
  rpcUrl,
  deployerPrivateKey,
  usdcAddress,
  adminAddress,
  creatorAddress
});
