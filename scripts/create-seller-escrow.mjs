import { createPublicClient, createWalletClient, getAddress, http, isHex, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";

import { loadCompiledArtifact } from "./lib/compile-evm-contracts.mjs";
import { optionalEnv, requiredEnv } from "./lib/deploy-escrow-v4.mjs";

function sellerIdHashFrom(input) {
  if (isHex(input) && input.length === 66) {
    return input;
  }
  return keccak256(stringToHex(input));
}

const network = (process.env.X402_EVM_NETWORK ?? "base").trim().toLowerCase();
const isEthereum = network === "ethereum";

const chain = isEthereum ? mainnet : base;
const networkLabel = isEthereum ? "ethereum-mainnet" : "base-mainnet";
const rpcUrl = isEthereum
  ? optionalEnv("X402_ETHEREUM_MAINNET_RPC_URL") ?? "https://ethereum-rpc.publicnode.com"
  : optionalEnv("X402_BASE_MAINNET_RPC_URL") ?? "https://mainnet.base.org";
const creatorPrivateKey = isEthereum
  ? optionalEnv(
      "X402_ETHEREUM_MAINNET_ESCROW_FACTORY_CREATOR_PRIVATE_KEY",
      "X402_ETHEREUM_MAINNET_DEPLOYER_PRIVATE_KEY",
      "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
      "X402_EVM_RELAYER_PRIVATE_KEY"
    ) ?? requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_FACTORY_CREATOR_PRIVATE_KEY")
  : optionalEnv(
      "X402_BASE_MAINNET_ESCROW_FACTORY_CREATOR_PRIVATE_KEY",
      "X402_BASE_MAINNET_DEPLOYER_PRIVATE_KEY",
      "X402_BASE_RELAYER_PRIVATE_KEY",
      "X402_EVM_RELAYER_PRIVATE_KEY"
    ) ?? requiredEnv("X402_BASE_MAINNET_ESCROW_FACTORY_CREATOR_PRIVATE_KEY");
const factoryAddress = getAddress(
  isEthereum
    ? requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_FACTORY_ADDRESS")
    : requiredEnv("X402_BASE_MAINNET_ESCROW_FACTORY_ADDRESS")
);
const escrowAdmin = getAddress(
  isEthereum
    ? optionalEnv("X402_ETHEREUM_MAINNET_ESCROW_ADMIN") ?? requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_ADMIN")
    : optionalEnv("X402_BASE_MAINNET_ESCROW_ADMIN") ?? requiredEnv("X402_BASE_MAINNET_ESCROW_ADMIN")
);
const escrowReleaser = getAddress(
  isEthereum
    ? optionalEnv("X402_ETHEREUM_MAINNET_ESCROW_RELEASER") ?? requiredEnv("X402_ETHEREUM_MAINNET_ESCROW_RELEASER")
    : optionalEnv("X402_BASE_MAINNET_ESCROW_RELEASER") ?? requiredEnv("X402_BASE_MAINNET_ESCROW_RELEASER")
);
const sellerId = optionalEnv("X402_ESCROW_SELLER_ID_HASH", "X402_ESCROW_SELLER_ID") ?? requiredEnv("X402_ESCROW_SELLER_ID");
const sellerIdHash = sellerIdHashFrom(sellerId);

const account = privateKeyToAccount(creatorPrivateKey);
const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl)
});
const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl)
});

const factoryArtifact = await loadCompiledArtifact("X402BaseUSDCReserveEscrowV4Factory");

console.log(
  JSON.stringify(
    {
      network: networkLabel,
      rpcUrl,
      factoryAddress,
      creator: account.address,
      sellerId,
      sellerIdHash,
      escrowAdmin,
      escrowReleaser
    },
    null,
    2
  )
);

const transactionHash = await walletClient.writeContract({
  address: factoryAddress,
  abi: factoryArtifact.abi,
  functionName: "createSellerEscrow",
  args: [sellerIdHash, escrowAdmin, escrowReleaser]
});

await publicClient.waitForTransactionReceipt({ hash: transactionHash });
const escrowContract = await publicClient.readContract({
  address: factoryAddress,
  abi: factoryArtifact.abi,
  functionName: "sellerEscrowOf",
  args: [sellerIdHash]
});

console.log(
  JSON.stringify(
    {
      transactionHash,
      sellerIdHash,
      escrowContract
    },
    null,
    2
  )
);
