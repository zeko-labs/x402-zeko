import {
  buildEvmRail,
  buildPaymentPayload,
  buildPaymentRequired,
  buildSettlementResponse,
  buildSignedEvmAuthorization,
  buildReserveReleaseResultCommitment,
  encodeBase64Json,
  InMemorySettlementLedger,
  SelfHostedEvmFacilitator,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  X402_RESERVE_RELEASE_ESCROW_ABI,
  verifyPayment
} from "../src/index.js";
import { loadCompiledArtifact } from "./lib/compile-evm-contracts.mjs";

import { createPublicClient, createWalletClient, formatEther, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const OFFICIAL_BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ERC20_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
];
const MOCK_USDC_ABI = [
  ...ERC20_ABI,
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  }
];
const ESCROW_VIEW_ABI = [
  {
    type: "function",
    name: "reservationOf",
    stateMutability: "view",
    inputs: [
      { name: "requestIdHash", type: "bytes32" },
      { name: "paymentIdHash", type: "bytes32" }
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "payer", type: "address" },
          { name: "payTo", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "resultCommitment", type: "bytes32" },
          { name: "status", type: "uint8" }
        ]
      }
    ]
  }
];

function readOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizePrivateKey(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value.startsWith("0x") ? value : `0x${value}`;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReserveReleaseRail({
  tokenAddress,
  payTo,
  amount,
  escrowContract,
  eip712Name
}) {
  return buildEvmRail({
    networkId: "eip155:84532",
    amount,
    assetSymbol: "USDC",
    decimals: 6,
    assetStandard: "erc20",
    tokenAddress,
    payTo,
    transferMethod: "eip3009",
    settlementModel: "x402-base-usdc-reserve-release-v2",
    description: "Base Sepolia reserve-release smoke path.",
    facilitatorMode: "evm-reserve-release",
    extensions: {
      evm: {
        chainId: 84532,
        chainName: "Base Sepolia",
        eip712Name,
        assetVersion: "2",
        transferMethod: "EIP-3009",
        reserveRelease: {
          escrowContract,
          reserveMethod: "reserveExactWithAuthorization",
          releaseMethod: "releaseReservedPayment",
          refundMethod: "refundExpiredPayment",
          resultCommitmentType: "sha256-canonical",
          expirySeconds: 3600
        }
      }
    }
  });
}

async function deployContract(walletClient, publicClient, artifact, args = []) {
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`Deployment failed for ${artifact.contractName}: ${hash}`);
  }
  if (receipt.status !== "success") {
    throw new Error(`Deployment reverted for ${artifact.contractName}: ${hash}`);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = await publicClient.getCode({ address: receipt.contractAddress });
    if (code && code !== "0x") {
      return {
        hash,
        address: receipt.contractAddress,
        receipt
      };
    }

    await sleep(1000);
  }

  throw new Error(`Contract code was not available after deployment for ${artifact.contractName}: ${hash}`);
}

async function waitForReservationVisible({
  publicClient,
  escrowAddress,
  tokenAddress,
  requestIdHash,
  paymentIdHash,
  amountAtomic
}) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const [reservation, escrowBalance] = await Promise.all([
      publicClient.readContract({
        address: escrowAddress,
        abi: ESCROW_VIEW_ABI,
        functionName: "reservationOf",
        args: [requestIdHash, paymentIdHash]
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [escrowAddress]
      })
    ]);

    if (Number(reservation.status) === 1 && escrowBalance >= amountAtomic) {
      return reservation;
    }

    await sleep(1000);
  }

  throw new Error("Reserved payment was not visible on-chain after waiting.");
}

async function releaseReservedPaymentWithRetry({
  publicClient,
  walletClient,
  escrowAddress,
  tokenAddress,
  payTo,
  requestIdHash,
  paymentIdHash,
  resultCommitment,
  amountAtomic,
  maxAttempts = 4
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let releaseTxHash = null;

    try {
      releaseTxHash = await walletClient.writeContract({
        address: escrowAddress,
        abi: X402_RESERVE_RELEASE_ESCROW_ABI,
        functionName: "releaseReservedPayment",
        args: [requestIdHash, paymentIdHash, resultCommitment]
      });
      const releaseReceipt = await publicClient.waitForTransactionReceipt({ hash: releaseTxHash });
      if (releaseReceipt.status !== "success") {
        throw new Error(`Release transaction reverted: ${releaseTxHash}`);
      }

      return {
        releaseTxHash,
        releaseReceipt,
        attempts: attempt,
        observedReleasedState: false
      };
    } catch (error) {
      lastError = error;
      const [reservation, escrowBalance, payToBalance] = await Promise.all([
        publicClient.readContract({
          address: escrowAddress,
          abi: ESCROW_VIEW_ABI,
          functionName: "reservationOf",
          args: [requestIdHash, paymentIdHash]
        }).catch(() => null),
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [escrowAddress]
        }).catch(() => null),
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [payTo]
        }).catch(() => null)
      ]);

      if (
        reservation &&
        Number(reservation.status) === 2 &&
        escrowBalance !== null &&
        payToBalance !== null &&
        escrowBalance === 0n &&
        payToBalance >= amountAtomic
      ) {
        return {
          releaseTxHash,
          releaseReceipt: null,
          attempts: attempt,
          observedReleasedState: true
        };
      }

      if (attempt === maxAttempts) {
        break;
      }

      await sleep(1500 * attempt);
    }
  }

  throw new Error(
    `Release failed after retries: ${lastError?.shortMessage ?? lastError?.message ?? String(lastError)}`
  );
}

async function waitForReleasedState({
  publicClient,
  escrowAddress,
  tokenAddress,
  payTo,
  requestIdHash,
  paymentIdHash,
  minimumPayToBalance
}) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const [reservation, escrowBalance, payToBalance] = await Promise.all([
      publicClient.readContract({
        address: escrowAddress,
        abi: ESCROW_VIEW_ABI,
        functionName: "reservationOf",
        args: [requestIdHash, paymentIdHash]
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [escrowAddress]
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [payTo]
      })
    ]);

    if (Number(reservation.status) === 2 && escrowBalance === 0n && payToBalance >= minimumPayToBalance) {
      return payToBalance;
    }

    await sleep(1000);
  }

  throw new Error("Released payment was not fully visible on-chain after waiting.");
}

function buildReserveReleaseIntent({
  tokenAddress,
  escrowContract,
  payerAddress,
  payTo,
  amount,
  requestId,
  paymentId,
  proofDigest,
  eip712Name
}) {
  const value = parseUnits(amount, 6).toString();
  const validBeforeUnix = String(Math.floor(Date.now() / 1000) + 3600);
  const nonce = `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`;
  const requestIdHash = buildReserveReleaseResultCommitment({ result: { requestId } });
  const paymentIdHash = buildReserveReleaseResultCommitment({ result: { paymentId } });
  const resultCommitment = buildReserveReleaseResultCommitment({
    requestId,
    paymentId,
    proofDigest
  });

  return {
    primitive: "evm-base-usdc-reserve-release-v2",
    settlementRail: "evm",
    network: {
      networkId: "eip155:84532",
      chainId: 84532,
      chainName: "Base Sepolia"
    },
    asset: {
      symbol: "USDC",
      decimals: 6,
      standard: "erc20",
      address: tokenAddress
    },
    transferMethod: "EIP-3009",
    facilitator: {
      kind: "evm-reserve-release",
      url: null
    },
    typedData: {
      domain: {
        name: eip712Name,
        version: "2",
        chainId: 84532,
        verifyingContract: tokenAddress
      },
      primaryType: "TransferWithAuthorization",
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" }
        ]
      },
      message: {
        from: payerAddress,
        to: escrowContract,
        value,
        validAfter: "0",
        validBefore: validBeforeUnix,
        nonce
      }
    },
    settlement: {
      mode: "reserve-release-v2",
      contractAddress: escrowContract,
      tokenAddress,
      payTo,
      requestIdHash,
      paymentIdHash,
      resultCommitment,
      reserveExpiryUnix: String(Math.floor(Date.now() / 1000) + 3600),
      reserveMethod: "reserveExactWithAuthorization",
      releaseMethod: "releaseReservedPayment",
      refundMethod: "refundExpiredPayment"
    }
  };
}

async function ensureTokenAndEscrow({
  publicClient,
  walletClient,
  buyerAddress,
  amountAtomic
}) {
  const configuredTokenAddress = readOptionalEnv("X402_BASE_SEPOLIA_TOKEN_ADDRESS");
  const configuredEscrowAddress = readOptionalEnv("X402_BASE_SEPOLIA_ESCROW_ADDRESS");
  const officialBalance = await publicClient.readContract({
    address: OFFICIAL_BASE_SEPOLIA_USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [buyerAddress]
  });

  if (configuredTokenAddress && configuredEscrowAddress) {
    return {
      tokenAddress: configuredTokenAddress,
      escrowAddress: configuredEscrowAddress,
      usingOfficialUsdc: configuredTokenAddress.toLowerCase() === OFFICIAL_BASE_SEPOLIA_USDC.toLowerCase(),
      deployed: []
    };
  }

  if (officialBalance >= amountAtomic && configuredEscrowAddress) {
    return {
      tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC,
      escrowAddress: configuredEscrowAddress,
      usingOfficialUsdc: true,
      deployed: []
    };
  }

  const deployed = [];
  const mockTokenArtifact = await loadCompiledArtifact("MockUSDC3009");
  const escrowArtifact = await loadCompiledArtifact("X402BaseUSDCReserveEscrow");

  const tokenDeployment = await deployContract(walletClient, publicClient, mockTokenArtifact);
  deployed.push({
    contract: "MockUSDC3009",
    address: tokenDeployment.address,
    transactionHash: tokenDeployment.hash
  });

  const mintReceipt = await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: tokenDeployment.address,
      abi: MOCK_USDC_ABI,
      functionName: "mint",
      args: [buyerAddress, amountAtomic * 10n],
      gas: 150000n
    })
  });
  if (mintReceipt.status !== "success") {
    throw new Error(`MockUSDC3009 mint reverted for buyer ${buyerAddress}.`);
  }

  const escrowDeployment = await deployContract(walletClient, publicClient, escrowArtifact, [
    tokenDeployment.address,
    walletClient.account.address,
    walletClient.account.address
  ]);
  deployed.push({
    contract: "X402BaseUSDCReserveEscrow",
    address: escrowDeployment.address,
    transactionHash: escrowDeployment.hash
  });

  return {
    tokenAddress: tokenDeployment.address,
    escrowAddress: escrowDeployment.address,
    usingOfficialUsdc: false,
    deployed
  };
}

async function main() {
  const rpcUrl = readOptionalEnv("X402_BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org");
  const buyer = privateKeyToAccount(
    normalizePrivateKey(
      readOptionalEnv("X402_EVM_PRIVATE_KEY"),
      "X402_EVM_PRIVATE_KEY"
    )
  );
  const relayer = privateKeyToAccount(
    normalizePrivateKey(
      readOptionalEnv("X402_BASE_RELAYER_PRIVATE_KEY", readOptionalEnv("X402_EVM_RELAYER_PRIVATE_KEY")),
      "X402_BASE_RELAYER_PRIVATE_KEY or X402_EVM_RELAYER_PRIVATE_KEY"
    )
  );
  const payTo = readOptionalEnv("X402_BASE_PAY_TO", readOptionalEnv("X402_EVM_PAY_TO"));
  if (!payTo) {
    throw new Error("X402_BASE_PAY_TO or X402_EVM_PAY_TO is required.");
  }

  const amount = readOptionalEnv("X402_BASE_SEPOLIA_USDC_AMOUNT", "0.01");
  const amountAtomic = parseUnits(amount, 6);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl)
  });
  const walletClient = createWalletClient({
    account: relayer,
    chain: baseSepolia,
    transport: http(rpcUrl)
  });
  const relayerEth = await publicClient.getBalance({ address: relayer.address });
  if (relayerEth === 0n) {
    throw new Error(`Relayer ${relayer.address} has 0 ETH on Base Sepolia.`);
  }

  const tokenAndEscrow = await ensureTokenAndEscrow({
    publicClient,
    walletClient,
    buyerAddress: buyer.address,
    amountAtomic
  });
  const buyerTokenBalance = await publicClient.readContract({
    address: tokenAndEscrow.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [buyer.address]
  });
  if (buyerTokenBalance < amountAtomic) {
    throw new Error(
      `Buyer ${buyer.address} holds only ${formatUnits(buyerTokenBalance, 6)} USDC on ${tokenAndEscrow.tokenAddress}, need ${amount}.`
    );
  }

  const rail = buildReserveReleaseRail({
    tokenAddress: tokenAndEscrow.tokenAddress,
    payTo,
    amount,
    escrowContract: tokenAndEscrow.escrowAddress,
    eip712Name: await publicClient.readContract({
      address: tokenAndEscrow.tokenAddress,
      abi: ERC20_ABI,
      functionName: "name"
    })
  });
  const sessionId = createId("session");
  const turnId = createId("turn");
  const paymentId = createId("pay");
  const paymentContext = {
    serviceId: "zeko-x402-base-sepolia-reserve-smoke",
    sessionId,
    turnId,
    baseUrl: "https://base-sepolia.local",
    proofBundleUrl: `https://base-sepolia.local/proof/${sessionId}.json`,
    verifyUrl: `https://base-sepolia.local/verify/${sessionId}`,
    description: "Base Sepolia reserve-release smoke path.",
    rails: [rail]
  };
  const paymentRequired = buildPaymentRequired(paymentContext);
  const accepted = paymentRequired.accepts[0];
  const proofDigest = `proof_${Date.now().toString(36)}`;
  const intent = buildReserveReleaseIntent({
    tokenAddress: tokenAndEscrow.tokenAddress,
    escrowContract: tokenAndEscrow.escrowAddress,
    payerAddress: buyer.address,
    payTo,
    amount,
    requestId: paymentRequired.requestId,
    paymentId,
    proofDigest,
    eip712Name: rail.extensions.evm.eip712Name
  });
  const signature = await buyer.signTypedData({
    domain: intent.typedData.domain,
    types: intent.typedData.types,
    primaryType: intent.typedData.primaryType,
    message: intent.typedData.message
  });
  const authorization = buildSignedEvmAuthorization(intent, { signature });
  const paymentPayload = buildPaymentPayload({
    requestId: paymentRequired.requestId,
    paymentId,
    option: accepted,
    payer: buyer.address,
    sessionId,
    turnId,
    authorization
  });
  const localVerification = verifyPayment({
    requirements: paymentRequired,
    payload: paymentPayload
  });
  if (!localVerification.ok) {
    throw new Error(localVerification.reason ?? "Local x402 verification failed.");
  }

  const facilitator = new SelfHostedEvmFacilitator({
    networks: [
      {
        networkId: "eip155:84532",
        rpcUrl,
        publicClient,
        walletClient,
        relayerPrivateKey: relayer.address === walletClient.account.address
          ? normalizePrivateKey(readOptionalEnv("X402_BASE_RELAYER_PRIVATE_KEY", readOptionalEnv("X402_EVM_RELAYER_PRIVATE_KEY")), "relayer key")
          : normalizePrivateKey(readOptionalEnv("X402_EVM_RELAYER_PRIVATE_KEY"), "relayer key")
      }
    ]
  });

  const verification = await facilitator.verify({
    paymentPayload,
    paymentRequirements: paymentRequired
  });
  const settlement = await facilitator.settle({
    paymentPayload,
    paymentRequirements: paymentRequired
  });
  if (!settlement?.success) {
    throw new Error(settlement?.errorReason ?? "Reserve transaction failed.");
  }

  const reserveTxHash =
    settlement.transactionHash ?? settlement.txHash ?? settlement.transaction;
  await waitForReservationVisible({
    publicClient,
    escrowAddress: tokenAndEscrow.escrowAddress,
    tokenAddress: tokenAndEscrow.tokenAddress,
    requestIdHash: intent.settlement.requestIdHash,
    paymentIdHash: intent.settlement.paymentIdHash,
    amountAtomic
  });
  const reserveBalance = await publicClient.readContract({
    address: tokenAndEscrow.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [tokenAndEscrow.escrowAddress]
  });
  const payToBalanceBeforeRelease = await publicClient.readContract({
    address: tokenAndEscrow.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [payTo]
  });
  const releaseResult = await releaseReservedPaymentWithRetry({
    publicClient,
    walletClient,
    escrowAddress: tokenAndEscrow.escrowAddress,
    tokenAddress: tokenAndEscrow.tokenAddress,
    payTo,
    requestIdHash: intent.settlement.requestIdHash,
    paymentIdHash: intent.settlement.paymentIdHash,
    resultCommitment: intent.settlement.resultCommitment,
    amountAtomic
  });
  const releaseTxHash = releaseResult.releaseTxHash ?? "released-state-observed";
  const releaseReceipt =
    releaseResult.releaseReceipt ??
    {
      blockNumber: 0n
    };
  const payToBalanceAfterRelease = await waitForReleasedState({
    publicClient,
    escrowAddress: tokenAndEscrow.escrowAddress,
    tokenAddress: tokenAndEscrow.tokenAddress,
    payTo,
    requestIdHash: intent.settlement.requestIdHash,
    paymentIdHash: intent.settlement.paymentIdHash,
    minimumPayToBalance: payToBalanceBeforeRelease + amountAtomic
  });

  const ledger = new InMemorySettlementLedger({
    sponsoredBudget: "10",
    budgetAsset: accepted.asset
  });
  const ledgerResult = ledger.settle({
    ...paymentPayload,
    resource: paymentRequired.resource,
    settlementReference: releaseTxHash
  });
  const paymentResponse = buildSettlementResponse({
    payload: paymentPayload,
    duplicate: ledgerResult.duplicate,
    eventIds: [...ledgerResult.settlement.eventIds, releaseTxHash],
    settledAtIso: ledgerResult.settlement.settledAtIso,
    remainingBudget: ledgerResult.remainingBudget,
    sponsoredBudget: ledgerResult.sponsoredBudget,
    budgetAsset: ledgerResult.budgetAsset,
    proofBundleUrl: paymentContext.proofBundleUrl,
    verifyUrl: paymentContext.verifyUrl,
    settlementModel: accepted.settlementModel,
    settlementReference: releaseTxHash,
    evm: {
      networkId: "eip155:84532",
      chainId: 84532,
      chainName: "Base Sepolia",
      facilitatorUrl: "self-hosted",
      verification,
      settlement: {
        ...settlement,
        releaseTransactionHash: releaseTxHash,
        releaseBlockNumber: releaseReceipt.blockNumber.toString(),
        tokenAddress: tokenAndEscrow.tokenAddress,
        escrowAddress: tokenAndEscrow.escrowAddress
      }
    }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        network: "eip155:84532",
        relayer: {
          address: relayer.address,
          ethBalance: formatEther(relayerEth)
        },
        asset: {
          symbol: "USDC",
          address: tokenAndEscrow.tokenAddress,
          usingOfficialUsdc: tokenAndEscrow.usingOfficialUsdc
        },
        deployed: tokenAndEscrow.deployed,
        escrow: {
          address: tokenAndEscrow.escrowAddress,
          reserveBalance: formatUnits(reserveBalance, 6)
        },
        balances: {
          payToBeforeRelease: formatUnits(payToBalanceBeforeRelease, 6),
          payToAfterRelease: formatUnits(payToBalanceAfterRelease, 6)
        },
        release: {
          attempts: releaseResult.attempts,
          observedReleasedState: releaseResult.observedReleasedState
        },
        reserveTxHash,
        releaseTxHash,
        paymentRequired,
        paymentPayload,
        paymentResponse,
        verification,
        settlement,
        headers: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodeBase64Json(paymentRequired),
          [X402_PAYMENT_SIGNATURE_HEADER]: encodeBase64Json(paymentPayload),
          [X402_PAYMENT_RESPONSE_HEADER]: encodeBase64Json(paymentResponse)
        }
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[zeko-x402:smoke-base-sepolia-reserve-release] failed", error);
  process.exit(1);
});
