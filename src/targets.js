import { buildEvmRail, buildZekoRail, defaultZekoAssetSymbol } from "./facilitator.js";

export const ZEKO_TESTNET_NETWORK = Object.freeze({
  networkId: "zeko:testnet",
  o1jsNetworkId: "zeko",
  graphql: "https://testnet.zeko.io/graphql",
  archive: "https://archive.testnet.zeko.io/graphql",
  explorer: "https://zekoscan.io/testnet"
});

export const BASE_MAINNET_USDC = Object.freeze({
  networkId: "eip155:8453",
  chainId: 8453,
  chainName: "Base",
  asset: {
    symbol: "USDC",
    decimals: 6,
    standard: "erc20",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  eip712Name: "USD Coin",
  transferMethod: "EIP-3009"
});

export const ETHEREUM_MAINNET_USDC = Object.freeze({
  networkId: "eip155:1",
  chainId: 1,
  chainName: "Ethereum",
  asset: {
    symbol: "USDC",
    decimals: 6,
    standard: "erc20",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  },
  eip712Name: "USD Coin",
  transferMethod: "EIP-3009"
});

function buildExactEip3009Rail(target, input) {
  return buildEvmRail({
    networkId: target.networkId,
    amount: input.amount,
    assetSymbol: target.asset.symbol,
    decimals: target.asset.decimals,
    assetStandard: target.asset.standard,
    tokenAddress: target.asset.address,
    payTo: input.payTo,
    transferMethod: "eip3009",
    settlementModel: input.settlementModel ?? "x402-exact-evm-v1",
    description: input.description,
    facilitatorMode: input.facilitatorMode ?? "x402-http",
    extensions: {
      evm: {
        chainId: target.chainId,
        chainName: target.chainName,
        eip712Name: target.eip712Name,
        assetVersion: input.assetVersion ?? "2",
        transferMethod: target.transferMethod,
        facilitatorUrl: input.facilitatorUrl ?? null,
        ...(typeof input.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: input.maxTimeoutSeconds } : {}),
        ...(typeof input.defaultFacilitator === "string" && input.defaultFacilitator.length > 0
          ? { defaultFacilitator: input.defaultFacilitator }
          : {}),
        ...(input.requiresCustomFacilitator === true ? { requiresCustomFacilitator: true } : {})
      }
    }
  });
}

function buildReserveReleaseRail(target, input) {
  if (typeof input?.escrowContract !== "string" || input.escrowContract.length === 0) {
    throw new Error("escrowContract is required for the reserve-release rail.");
  }

  const hasProtocolFeePayTo =
    typeof input?.protocolFeePayTo === "string" && input.protocolFeePayTo.length > 0;
  const hasFeeExtras =
    input?.feeBps !== undefined ||
    (typeof input?.feeSettlementMode === "string" && input.feeSettlementMode.length > 0) ||
    (typeof input?.feePolicyDigest === "string" && input.feePolicyDigest.length > 0);

  if (hasFeeExtras && !hasProtocolFeePayTo) {
    throw new Error("protocolFeePayTo is required when configuring a reserve-release fee split.");
  }

  const feeBps =
    hasProtocolFeePayTo
      ? (() => {
          if (!Number.isInteger(input?.feeBps) || input.feeBps <= 0 || input.feeBps >= 10_000) {
            throw new Error("feeBps must be an integer between 1 and 9999 for reserve-release fee rails.");
          }

          return input.feeBps;
        })()
      : null;

  return buildEvmRail({
    networkId: target.networkId,
    amount: input.amount,
    assetSymbol: target.asset.symbol,
    decimals: target.asset.decimals,
    assetStandard: target.asset.standard,
    tokenAddress: target.asset.address,
    payTo: input.payTo,
    transferMethod: "eip3009",
    settlementModel: input.settlementModel ?? "x402-evm-usdc-reserve-release-v2",
    description: input.description,
    facilitatorMode: input.facilitatorMode ?? "evm-reserve-release",
    extensions: {
      evm: {
        chainId: target.chainId,
        chainName: target.chainName,
        eip712Name: target.eip712Name,
        assetVersion: input.assetVersion ?? "2",
        transferMethod: target.transferMethod,
        facilitatorUrl: input.facilitatorUrl ?? null,
        reserveRelease: {
          escrowContract: input.escrowContract,
          reserveMethod: input.reserveMethod ?? "reserveExactWithAuthorization",
          releaseMethod: input.releaseMethod ?? "releaseReservedPayment",
          refundMethod: input.refundMethod ?? "refundExpiredPayment",
          resultCommitmentType: input.resultCommitmentType ?? "sha256-canonical",
          ...(typeof input.expirySeconds === "number" ? { expirySeconds: input.expirySeconds } : {})
        },
        ...(typeof input.protocolFeePayTo === "string" && input.protocolFeePayTo.length > 0
          ? {
              feeSplit: {
                version: "protocol-owner-fee-v1",
                feeBps,
                sellerPayTo: input.payTo,
                protocolFeePayTo: input.protocolFeePayTo,
                feeSettlementMode: input.feeSettlementMode ?? "split-release-v1",
                ...(typeof input.feePolicyDigest === "string" && input.feePolicyDigest.length > 0
                  ? { feePolicyDigest: input.feePolicyDigest }
                  : {})
              }
            }
          : {}),
        ...(typeof input.defaultFacilitator === "string" && input.defaultFacilitator.length > 0
          ? { defaultFacilitator: input.defaultFacilitator }
          : {}),
        ...(input.requiresCustomFacilitator === true ? { requiresCustomFacilitator: true } : {}),
        ...(typeof input.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: input.maxTimeoutSeconds } : {})
      }
    }
  });
}

export function buildZekoSettlementContractRail(input) {
  if (typeof input?.contractAddress !== "string" || input.contractAddress.length === 0) {
    throw new Error("contractAddress is required for the Zeko settlement contract rail.");
  }

  if (typeof input?.beneficiaryAddress !== "string" || input.beneficiaryAddress.length === 0) {
    throw new Error("beneficiaryAddress is required for the Zeko settlement contract rail.");
  }

  const networkId = input.networkId ?? ZEKO_TESTNET_NETWORK.networkId;
  const assetSymbol = input.assetSymbol ?? defaultZekoAssetSymbol(networkId);

  return buildZekoRail({
    networkId,
    amount: input.amount,
    payTo: input.contractAddress,
    serviceTier: input.serviceTier,
    description:
      input.description ??
      `Zeko settlement-contract rail using an onchain zkApp call plus a signed ${assetSymbol} transfer into the settlement contract.`,
    bundleDigestSha256: input.bundleDigestSha256,
    programmablePrivacy: input.programmablePrivacy,
    kernelPath: input.kernelPath ?? ["x402Settlement.settleExact"],
    facilitatorMode: "zeko-settlement-contract",
    settlementModel: "x402-exact-settlement-zkapp-v1",
    assetSymbol,
    decimals: 9,
    extensions: {
      zeko: {
        primitive: "zeko-exact-settlement-zkapp-v1",
        contractAddress: input.contractAddress,
        beneficiaryAddress: input.beneficiaryAddress,
        graphql: input.graphql ?? ZEKO_TESTNET_NETWORK.graphql,
        archive: input.archive ?? ZEKO_TESTNET_NETWORK.archive,
        explorer: input.explorer ?? ZEKO_TESTNET_NETWORK.explorer
      }
    }
  });
}

export function buildBaseMainnetUsdcRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Base USDC rail.");
  }

  return buildExactEip3009Rail(BASE_MAINNET_USDC, {
    ...input,
    description:
      input.description ??
      "Base mainnet USDC rail using x402 exact EIP-3009 settlement.",
    defaultFacilitator: input.defaultFacilitator ?? "cdp"
  });
}

export function buildBaseMainnetUsdcReserveReleaseRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Base USDC reserve-release rail.");
  }

  return buildReserveReleaseRail(BASE_MAINNET_USDC, {
    ...input,
    settlementModel: input.settlementModel ?? "x402-base-usdc-reserve-release-v2",
    description:
      input.description ??
      "Base mainnet USDC rail using reserve-now, release-on-proof settlement.",
    defaultFacilitator: input.defaultFacilitator ?? "self-hosted"
  });
}

export function buildEthereumMainnetUsdcRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Ethereum mainnet USDC rail.");
  }

  return buildExactEip3009Rail(ETHEREUM_MAINNET_USDC, {
    ...input,
    description:
      input.description ??
      "Ethereum mainnet USDC rail using x402 exact EIP-3009 settlement.",
    requiresCustomFacilitator:
      input.requiresCustomFacilitator ??
      !(typeof input.facilitatorUrl === "string" && input.facilitatorUrl.length > 0)
  });
}

export function buildEthereumMainnetUsdcReserveReleaseRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Ethereum USDC reserve-release rail.");
  }

  return buildReserveReleaseRail(ETHEREUM_MAINNET_USDC, {
    ...input,
    settlementModel: input.settlementModel ?? "x402-ethereum-mainnet-usdc-reserve-release-v2",
    description:
      input.description ??
      "Ethereum mainnet USDC rail using reserve-now, release-on-proof settlement.",
    defaultFacilitator: input.defaultFacilitator ?? "self-hosted",
    requiresCustomFacilitator:
      input.requiresCustomFacilitator ??
      !(typeof input.facilitatorUrl === "string" && input.facilitatorUrl.length > 0)
  });
}

export function buildBaseMainnetUsdcReserveReleaseFeeRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Base USDC reserve-release fee rail.");
  }

  if (typeof input?.protocolFeePayTo !== "string" || input.protocolFeePayTo.length === 0) {
    throw new Error("protocolFeePayTo is required for the Base USDC reserve-release fee rail.");
  }

  return buildReserveReleaseRail(BASE_MAINNET_USDC, {
    ...input,
    settlementModel: input.settlementModel ?? "x402-base-usdc-reserve-release-v3",
    reserveMethod: input.reserveMethod ?? "reserveExactWithAuthorizationSplit",
    description:
      input.description ??
      "Base mainnet USDC rail using reserve-now, release-on-proof settlement with a protocol owner fee split.",
    defaultFacilitator: input.defaultFacilitator ?? "self-hosted"
  });
}

export function buildEthereumMainnetUsdcReserveReleaseFeeRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Ethereum USDC reserve-release fee rail.");
  }

  if (typeof input?.protocolFeePayTo !== "string" || input.protocolFeePayTo.length === 0) {
    throw new Error("protocolFeePayTo is required for the Ethereum USDC reserve-release fee rail.");
  }

  return buildReserveReleaseRail(ETHEREUM_MAINNET_USDC, {
    ...input,
    settlementModel: input.settlementModel ?? "x402-ethereum-mainnet-usdc-reserve-release-v3",
    reserveMethod: input.reserveMethod ?? "reserveExactWithAuthorizationSplit",
    description:
      input.description ??
      "Ethereum mainnet USDC rail using reserve-now, release-on-proof settlement with a protocol owner fee split.",
    defaultFacilitator: input.defaultFacilitator ?? "self-hosted",
    requiresCustomFacilitator:
      input.requiresCustomFacilitator ??
      !(typeof input.facilitatorUrl === "string" && input.facilitatorUrl.length > 0)
  });
}

export function buildBaseMainnetUsdcReserveReleaseFeeOnReserveRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Base USDC reserve-release fee-on-reserve rail.");
  }

  if (typeof input?.protocolFeePayTo !== "string" || input.protocolFeePayTo.length === 0) {
    throw new Error("protocolFeePayTo is required for the Base USDC reserve-release fee-on-reserve rail.");
  }

  return buildReserveReleaseRail(BASE_MAINNET_USDC, {
    ...input,
    settlementModel: input.settlementModel ?? "x402-base-usdc-reserve-release-v4",
    reserveMethod: input.reserveMethod ?? "reserveExactWithAuthorizationSplitImmediateFee",
    feeSettlementMode: input.feeSettlementMode ?? "fee-on-reserve-v1",
    description:
      input.description ??
      "Base mainnet USDC rail using reserve-now, release-on-proof seller settlement with the protocol fee collected at reservation time.",
    defaultFacilitator: input.defaultFacilitator ?? "self-hosted"
  });
}

export function buildEthereumMainnetUsdcReserveReleaseFeeOnReserveRail(input) {
  if (typeof input?.payTo !== "string" || input.payTo.length === 0) {
    throw new Error("payTo is required for the Ethereum USDC reserve-release fee-on-reserve rail.");
  }

  if (typeof input?.protocolFeePayTo !== "string" || input.protocolFeePayTo.length === 0) {
    throw new Error("protocolFeePayTo is required for the Ethereum USDC reserve-release fee-on-reserve rail.");
  }

  return buildReserveReleaseRail(ETHEREUM_MAINNET_USDC, {
    ...input,
    settlementModel: input.settlementModel ?? "x402-ethereum-mainnet-usdc-reserve-release-v4",
    reserveMethod: input.reserveMethod ?? "reserveExactWithAuthorizationSplitImmediateFee",
    feeSettlementMode: input.feeSettlementMode ?? "fee-on-reserve-v1",
    description:
      input.description ??
      "Ethereum mainnet USDC rail using reserve-now, release-on-proof seller settlement with the protocol fee collected at reservation time.",
    defaultFacilitator: input.defaultFacilitator ?? "self-hosted",
    requiresCustomFacilitator:
      input.requiresCustomFacilitator ??
      !(typeof input.facilitatorUrl === "string" && input.facilitatorUrl.length > 0)
  });
}

export function buildCircleGatewayBaseUsdcRail(input) {
  const baseRail = buildBaseMainnetUsdcRail({
    ...input,
    description:
      input?.description ??
      "Base mainnet USDC rail using Circle Gateway batching through x402-compatible facilitator flows.",
    facilitatorMode: "circle-gateway"
  });

  return {
    ...baseRail,
    settlementModel: "circle-gateway-batched",
    extensions: {
      ...baseRail.extensions,
      evm: {
        ...baseRail.extensions.evm,
        primitive: "evm-base-usdc-circle-gateway-v1",
        batching: true,
        typedDataDomainName: "GatewayWalletBatched",
        typedDataDomainVersion: "1",
        ...(typeof input?.verifyingContract === "string" && input.verifyingContract.length > 0
          ? { verifyingContract: input.verifyingContract }
          : {}),
        requiresVerifyingContractFrom402:
          !(typeof input?.verifyingContract === "string" && input.verifyingContract.length > 0)
      }
    }
  };
}
