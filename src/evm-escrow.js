import { getAddress, keccak256, toBytes } from "viem";

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeAddress(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  return getAddress(value).toLowerCase();
}

function assertAddressLike(label, value) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} is required.`);
  }

  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address.`);
  }
}

export const X402_RELEASER_ROLE = keccak256(toBytes("RELEASER_ROLE"));
export const X402_PAUSER_ROLE = keccak256(toBytes("PAUSER_ROLE"));
export const X402_EVM_USDC_RESERVE_RELEASE_KIND = "x402-evm-usdc-reserve-release-v2";

export const X402_RESERVE_RELEASE_ESCROW_INSPECTION_ABI = [
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
];

export async function inspectReserveReleaseEscrow(input) {
  const publicClient = input?.publicClient;

  if (!publicClient || typeof publicClient.getCode !== "function" || typeof publicClient.readContract !== "function") {
    throw new Error("publicClient with getCode and readContract is required.");
  }

  const escrowAddress = assertAddressLike("escrowAddress", input?.escrowAddress);
  const expectedTokenAddress = isNonEmptyString(input?.expectedTokenAddress)
    ? assertAddressLike("expectedTokenAddress", input.expectedTokenAddress)
    : null;
  const releaserAddress = isNonEmptyString(input?.releaserAddress)
    ? assertAddressLike("releaserAddress", input.releaserAddress)
    : null;
  const pauserAddress = isNonEmptyString(input?.pauserAddress)
    ? assertAddressLike("pauserAddress", input.pauserAddress)
    : null;

  const code = await publicClient.getCode({ address: escrowAddress });
  const codePresent = Boolean(code && code !== "0x");

  if (!codePresent) {
    return {
      ok: false,
      contractKind: X402_EVM_USDC_RESERVE_RELEASE_KIND,
      escrowAddress,
      codePresent,
      inspectionErrors: ["No contract code found at escrowAddress."]
    };
  }

  const inspectionErrors = [];
  let tokenAddress = null;
  let releaserAuthorized = null;
  let pauserAuthorized = null;

  try {
    tokenAddress = await publicClient.readContract({
      address: escrowAddress,
      abi: X402_RESERVE_RELEASE_ESCROW_INSPECTION_ABI,
      functionName: "usdc"
    });
  } catch (error) {
    inspectionErrors.push(
      `Could not read escrow token address: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (releaserAddress) {
    try {
      releaserAuthorized = await publicClient.readContract({
        address: escrowAddress,
        abi: X402_RESERVE_RELEASE_ESCROW_INSPECTION_ABI,
        functionName: "hasRole",
        args: [X402_RELEASER_ROLE, releaserAddress]
      });
    } catch (error) {
      inspectionErrors.push(
        `Could not read releaser role membership: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (pauserAddress) {
    try {
      pauserAuthorized = await publicClient.readContract({
        address: escrowAddress,
        abi: X402_RESERVE_RELEASE_ESCROW_INSPECTION_ABI,
        functionName: "hasRole",
        args: [X402_PAUSER_ROLE, pauserAddress]
      });
    } catch (error) {
      inspectionErrors.push(
        `Could not read pauser role membership: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const matchesExpectedToken =
    expectedTokenAddress === null
      ? null
      : normalizeAddress(tokenAddress) === normalizeAddress(expectedTokenAddress);

  if (expectedTokenAddress && matchesExpectedToken === false) {
    inspectionErrors.push("Escrow token address does not match the expected settlement token.");
  }

  if (releaserAddress && releaserAuthorized === false) {
    inspectionErrors.push("Escrow does not grant RELEASER_ROLE to the configured releaser.");
  }

  if (pauserAddress && pauserAuthorized === false) {
    inspectionErrors.push("Escrow does not grant PAUSER_ROLE to the configured pauser.");
  }

  return {
    ok: inspectionErrors.length === 0,
    contractKind: X402_EVM_USDC_RESERVE_RELEASE_KIND,
    escrowAddress,
    codePresent,
    tokenAddress,
    expectedTokenAddress,
    matchesExpectedToken,
    releaserRole: X402_RELEASER_ROLE,
    releaserAddress,
    releaserAuthorized,
    pauserRole: X402_PAUSER_ROLE,
    pauserAddress,
    pauserAuthorized,
    inspectionErrors
  };
}
