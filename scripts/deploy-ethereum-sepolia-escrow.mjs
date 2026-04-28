import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http } from "viem";
import { sepolia } from "viem/chains";

import { loadCompiledArtifact } from "./lib/compile-evm-contracts.mjs";

const OFFICIAL_ETHEREUM_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function optionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  return null;
}

const rpcUrl = optionalEnv("X402_ETHEREUM_SEPOLIA_RPC_URL") ?? "https://ethereum-sepolia-rpc.publicnode.com";
const deployerPrivateKey =
  optionalEnv(
    "X402_ETHEREUM_SEPOLIA_DEPLOYER_PRIVATE_KEY",
    "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ) ?? requiredEnv("X402_ETHEREUM_SEPOLIA_DEPLOYER_PRIVATE_KEY");
const usdcAddress = getAddress(
  optionalEnv("X402_ETHEREUM_SEPOLIA_USDC_ADDRESS") ?? OFFICIAL_ETHEREUM_SEPOLIA_USDC
);

const deployer = privateKeyToAccount(deployerPrivateKey);
const adminAddress = getAddress(optionalEnv("X402_ETHEREUM_SEPOLIA_ESCROW_ADMIN") ?? deployer.address);
const releaserAddress = getAddress(optionalEnv("X402_ETHEREUM_SEPOLIA_ESCROW_RELEASER") ?? adminAddress);

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl)
});
const walletClient = createWalletClient({
  account: deployer,
  chain: sepolia,
  transport: http(rpcUrl)
});

const artifact = await loadCompiledArtifact("X402BaseUSDCReserveEscrow");
const balance = await publicClient.getBalance({ address: deployer.address });

console.log(
  JSON.stringify(
    {
      network: "ethereum-sepolia",
      chainId: sepolia.id,
      rpcUrl,
      deployer: deployer.address,
      deployerEthBalance: formatUnits(balance, 18),
      usdcAddress,
      adminAddress,
      releaserAddress
    },
    null,
    2
  )
);

if (balance === 0n) {
  throw new Error(`Deployer ${deployer.address} has 0 ETH on Ethereum Sepolia`);
}

const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [usdcAddress, adminAddress, releaserAddress]
});

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (!receipt.contractAddress) {
  throw new Error(`Deployment failed without a contract address: ${hash}`);
}

console.log(
  JSON.stringify(
    {
      transactionHash: hash,
      contractAddress: receipt.contractAddress,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString()
    },
    null,
    2
  )
);
