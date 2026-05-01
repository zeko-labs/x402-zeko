import { mainnet } from "viem/chains";

import { deployEscrowV4Factory, optionalEnv, requiredEnv } from "./lib/deploy-escrow-v4.mjs";

const OFFICIAL_ETHEREUM_MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const rpcUrl = optionalEnv("X402_ETHEREUM_MAINNET_RPC_URL") ?? "https://ethereum-rpc.publicnode.com";
const deployerPrivateKey =
  optionalEnv(
    "X402_ETHEREUM_MAINNET_DEPLOYER_PRIVATE_KEY",
    "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ) ?? requiredEnv("X402_ETHEREUM_MAINNET_DEPLOYER_PRIVATE_KEY");
const usdcAddress = optionalEnv("X402_ETHEREUM_MAINNET_USDC_ADDRESS") ?? OFFICIAL_ETHEREUM_MAINNET_USDC;
const adminAddress =
  optionalEnv("X402_ETHEREUM_MAINNET_ESCROW_FACTORY_ADMIN", "X402_ETHEREUM_MAINNET_ESCROW_ADMIN") ??
  requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_FACTORY_ADMIN");
const creatorAddress =
  optionalEnv("X402_ETHEREUM_MAINNET_ESCROW_FACTORY_CREATOR", "X402_ETHEREUM_MAINNET_ESCROW_RELEASER") ??
  requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_FACTORY_CREATOR");

await deployEscrowV4Factory({
  network: "ethereum-mainnet",
  chain: mainnet,
  rpcUrl,
  deployerPrivateKey,
  usdcAddress,
  adminAddress,
  creatorAddress
});
