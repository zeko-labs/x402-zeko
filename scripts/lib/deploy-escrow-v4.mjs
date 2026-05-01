import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http } from "viem";

import { loadCompiledArtifact } from "./compile-evm-contracts.mjs";

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

export function optionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  return null;
}

async function deployArtifact({ artifactName, chain, rpcUrl, deployerPrivateKey, args, context }) {
  const deployer = privateKeyToAccount(deployerPrivateKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl)
  });
  const walletClient = createWalletClient({
    account: deployer,
    chain,
    transport: http(rpcUrl)
  });
  const artifact = await loadCompiledArtifact(artifactName);
  const balance = await publicClient.getBalance({ address: deployer.address });

  console.log(
    JSON.stringify(
      {
        network: context.network,
        chainId: chain.id,
        rpcUrl,
        deployer: deployer.address,
        deployerNativeBalance: formatUnits(balance, 18),
        ...context.meta
      },
      null,
      2
    )
  );

  if (balance === 0n) {
    throw new Error(`Deployer ${deployer.address} has 0 native gas on ${context.network}`);
  }

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`Deployment failed without a contract address: ${hash}`);
  }

  console.log(
    JSON.stringify(
      {
        artifactName,
        transactionHash: hash,
        contractAddress: receipt.contractAddress,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString()
      },
      null,
      2
    )
  );

  return {
    transactionHash: hash,
    contractAddress: receipt.contractAddress,
    deployer: deployer.address
  };
}

export async function deployEscrowV4({
  network,
  chain,
  rpcUrl,
  deployerPrivateKey,
  usdcAddress,
  adminAddress,
  releaserAddress
}) {
  return deployArtifact({
    artifactName: "X402BaseUSDCReserveEscrowV4",
    chain,
    rpcUrl,
    deployerPrivateKey,
    args: [getAddress(usdcAddress), getAddress(adminAddress), getAddress(releaserAddress)],
    context: {
      network,
      meta: {
        usdcAddress: getAddress(usdcAddress),
        adminAddress: getAddress(adminAddress),
        releaserAddress: getAddress(releaserAddress)
      }
    }
  });
}

export async function deployEscrowV4Factory({
  network,
  chain,
  rpcUrl,
  deployerPrivateKey,
  usdcAddress,
  adminAddress,
  creatorAddress
}) {
  return deployArtifact({
    artifactName: "X402BaseUSDCReserveEscrowV4Factory",
    chain,
    rpcUrl,
    deployerPrivateKey,
    args: [getAddress(usdcAddress), getAddress(adminAddress), getAddress(creatorAddress)],
    context: {
      network,
      meta: {
        usdcAddress: getAddress(usdcAddress),
        adminAddress: getAddress(adminAddress),
        creatorAddress: getAddress(creatorAddress)
      }
    }
  });
}
