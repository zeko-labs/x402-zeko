import { createServer } from "node:http";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  verifyTypedData
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";

import { buildHostedFacilitatorRequest } from "./facilitator-client.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function parseChainId(networkId) {
  if (typeof networkId !== "string" || !networkId.startsWith("eip155:")) {
    throw new Error(`Unsupported EVM networkId: ${networkId ?? "unknown"}`);
  }

  const [, chainIdText] = networkId.split(":");
  const chainId = Number(chainIdText);

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid EVM chainId in networkId: ${networkId}`);
  }

  return chainId;
}

function getChain(networkId) {
  if (networkId === "eip155:8453") {
    return base;
  }

  if (networkId === "eip155:1") {
    return mainnet;
  }

  return undefined;
}

function transferWithAuthorizationTypes() {
  return {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };
}

export const USDC_EIP3009_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "authorizationState",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "transferWithAuthorization",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  }
];

function normalizeHostedRequest(input) {
  if (
    isRecord(input?.paymentPayload) &&
    isRecord(input.paymentPayload.accepted) &&
    isRecord(input.paymentPayload.payload)
  ) {
    return input;
  }

  if (isRecord(input?.paymentPayload) && isRecord(input?.paymentRequirements)) {
    return buildHostedFacilitatorRequest(input);
  }

  throw new Error(
    "Expected a hosted x402 facilitator request or an internal { paymentPayload, paymentRequirements } pair."
  );
}

function normalizeHostedExactPayment(input) {
  const request = normalizeHostedRequest(input);
  const hostedPaymentPayload = request.paymentPayload;
  const accepted = hostedPaymentPayload.accepted;
  const payload = hostedPaymentPayload.payload;
  const authorization = payload.authorization;
  const signature = payload.signature;
  const networkId = assertNonEmptyString("paymentPayload.accepted.network", accepted?.network);
  const chainId = parseChainId(networkId);
  const tokenAddress = assertNonEmptyString("paymentPayload.accepted.asset", accepted?.asset);
  const payTo = assertNonEmptyString("paymentPayload.accepted.payTo", accepted?.payTo);
  const domainName = assertNonEmptyString(
    "paymentPayload.accepted.extra.name",
    accepted?.extra?.name ?? "USD Coin"
  );
  const domainVersion = accepted?.extra?.version ?? "2";

  if (!isRecord(authorization)) {
    throw new Error("paymentPayload.payload.authorization is required.");
  }

  if (typeof signature !== "string" || signature.length === 0) {
    throw new Error("paymentPayload.payload.signature is required.");
  }

  const from = assertNonEmptyString("authorization.from", authorization.from);
  const to = assertNonEmptyString("authorization.to", authorization.to);
  const value = BigInt(assertNonEmptyString("authorization.value", authorization.value));
  const validAfter = BigInt(assertNonEmptyString("authorization.validAfter", authorization.validAfter));
  const validBefore = BigInt(assertNonEmptyString("authorization.validBefore", authorization.validBefore));
  const nonce = assertNonEmptyString("authorization.nonce", authorization.nonce);
  const acceptedAmount = BigInt(assertNonEmptyString("paymentPayload.accepted.amount", accepted.amount));

  if (to.toLowerCase() !== payTo.toLowerCase()) {
    throw new Error("Hosted payment authorization.to must match paymentPayload.accepted.payTo.");
  }

  if (value !== acceptedAmount) {
    throw new Error("Hosted payment authorization.value must match paymentPayload.accepted.amount.");
  }

  return {
    request,
    hostedPaymentPayload,
    accepted,
    signature,
    networkId,
    chainId,
    tokenAddress,
    payTo,
    payer: from,
    authorization: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce
    },
    typedData: {
      domain: {
        name: domainName,
        version: domainVersion,
        chainId,
        verifyingContract: tokenAddress
      },
      primaryType: "TransferWithAuthorization",
      types: transferWithAuthorizationTypes(),
      message: {
        from,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce
      }
    }
  };
}

function makeClients(config) {
  const networkId = assertNonEmptyString("networkId", config?.networkId);
  const rpcUrl = assertNonEmptyString("rpcUrl", config?.rpcUrl);
  const relayerPrivateKey = normalizePrivateKey(
    assertNonEmptyString("relayerPrivateKey", config?.relayerPrivateKey)
  );
  const chain = getChain(networkId);
  const account = privateKeyToAccount(relayerPrivateKey);
  const publicClient =
    config?.publicClient ??
    createPublicClient({
      ...(chain ? { chain } : {}),
      transport: http(rpcUrl)
    });
  const walletClient =
    config?.walletClient ??
    createWalletClient({
      account,
      ...(chain ? { chain } : {}),
      transport: http(rpcUrl)
    });

  return {
    networkId,
    chain,
    rpcUrl,
    account,
    publicClient,
    walletClient
  };
}

async function readAuthorizationState(clients, payment) {
  return await clients.publicClient.readContract({
    address: payment.tokenAddress,
    abi: USDC_EIP3009_ABI,
    functionName: "authorizationState",
    args: [payment.authorization.from, payment.authorization.nonce]
  });
}

async function readBalance(clients, payment) {
  return await clients.publicClient.readContract({
    address: payment.tokenAddress,
    abi: USDC_EIP3009_ABI,
    functionName: "balanceOf",
    args: [payment.authorization.from]
  });
}

function verificationSummary(payment, clients, input) {
  return {
    isValid: input.isValid,
    ok: input.isValid,
    network: payment.networkId,
    payer: payment.payer,
    payTo: payment.payTo,
    asset: payment.accepted.asset,
    amount: payment.accepted.amount,
    relayer: clients.account.address,
    authorizationUsed: input.authorizationUsed,
    balance: input.balance.toString(),
    ...(input.invalidReason ? { invalidReason: input.invalidReason, error: input.invalidReason } : {})
  };
}

async function verifyHostedPayment(clients, input) {
  const payment = normalizeHostedExactPayment(input);
  const signatureValid = await verifyTypedData({
    address: payment.authorization.from,
    domain: payment.typedData.domain,
    types: payment.typedData.types,
    primaryType: payment.typedData.primaryType,
    message: payment.typedData.message,
    signature: payment.signature
  });

  if (!signatureValid) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "EIP-3009 signature verification failed.",
      authorizationUsed: false,
      balance: 0n
    });
  }

  const [authorizationUsed, balance] = await Promise.all([
    readAuthorizationState(clients, payment),
    readBalance(clients, payment)
  ]);

  if (authorizationUsed) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "EIP-3009 authorization nonce was already used.",
      authorizationUsed,
      balance
    });
  }

  if (balance < payment.authorization.value) {
    return verificationSummary(payment, clients, {
      isValid: false,
      invalidReason: "Payer does not hold enough USDC for the requested x402 payment.",
      authorizationUsed,
      balance
    });
  }

  return verificationSummary(payment, clients, {
    isValid: true,
    authorizationUsed,
    balance
  });
}

async function settleHostedPayment(clients, input) {
  const payment = normalizeHostedExactPayment(input);
  const verification = await verifyHostedPayment(clients, input);

  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? "Hosted EVM payment verification failed.",
      verification
    };
  }

  const { v, r, s } = parseSignature(payment.signature);

  try {
    const transactionHash = await clients.walletClient.writeContract({
      account: clients.account,
      chain: clients.chain,
      address: payment.tokenAddress,
      abi: USDC_EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [
        payment.authorization.from,
        payment.authorization.to,
        payment.authorization.value,
        payment.authorization.validAfter,
        payment.authorization.validBefore,
        payment.authorization.nonce,
        v,
        r,
        s
      ]
    });
    const receipt =
      typeof clients.publicClient.waitForTransactionReceipt === "function"
        ? await clients.publicClient.waitForTransactionReceipt({ hash: transactionHash })
        : null;

    return {
      success: true,
      network: payment.networkId,
      payer: payment.payer,
      payTo: payment.payTo,
      relayer: clients.account.address,
      transaction: transactionHash,
      txHash: transactionHash,
      transactionHash,
      ...(receipt
        ? {
            receipt: {
              status: receipt.status,
              blockHash: receipt.blockHash,
              blockNumber:
                typeof receipt.blockNumber === "bigint"
                  ? receipt.blockNumber.toString()
                  : receipt.blockNumber
            }
          }
        : {})
    };
  } catch (error) {
    const authorizationUsed = await readAuthorizationState(clients, payment).catch(() => false);

    return {
      success: false,
      errorReason: authorizationUsed
        ? "EIP-3009 authorization nonce was already used."
        : error instanceof Error
          ? error.message
          : String(error),
      verification: {
        ...verification,
        authorizationUsed
      }
    };
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        if (chunks.length === 0) {
          resolve({});
          return;
        }

        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export class SelfHostedEvmFacilitator {
  constructor(input = {}) {
    const networks = Array.isArray(input.networks) ? input.networks : [];

    if (networks.length === 0) {
      throw new Error("SelfHostedEvmFacilitator requires at least one configured EVM network.");
    }

    this.networks = new Map(
      networks.map((network) => [network.networkId, makeClients(network)])
    );
  }

  getClients(networkId) {
    const clients = this.networks.get(networkId);

    if (!clients) {
      throw new Error(`Self-hosted EVM facilitator is not configured for ${networkId}.`);
    }

    return clients;
  }

  async supported() {
    return {
      ok: true,
      networks: [...this.networks.values()].map((entry) => ({
        networkId: entry.networkId,
        rpcUrl: entry.rpcUrl,
        relayer: entry.account.address
      }))
    };
  }

  async verify(input) {
    const payment = normalizeHostedExactPayment(input);
    const clients = this.getClients(payment.networkId);
    return await verifyHostedPayment(clients, input);
  }

  async settle(input) {
    const payment = normalizeHostedExactPayment(input);
    const clients = this.getClients(payment.networkId);
    return await settleHostedPayment(clients, input);
  }

  async verifyAndSettle(input) {
    const verification = await this.verify(input);

    if (verification?.isValid === false || verification?.ok === false) {
      return {
        verification,
        settlement: null
      };
    }

    const settlement = await this.settle(input);
    return {
      verification,
      settlement
    };
  }
}

export function createSelfHostedEvmFacilitatorHttpServer(input = {}) {
  const facilitator =
    input.facilitator instanceof SelfHostedEvmFacilitator
      ? input.facilitator
      : new SelfHostedEvmFacilitator(input);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/supported") {
        sendJson(response, 200, await facilitator.supported());
        return;
      }

      if (request.method === "POST" && url.pathname === "/verify") {
        const body = await readJsonBody(request);
        sendJson(response, 200, await facilitator.verify(body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/settle") {
        const body = await readJsonBody(request);
        sendJson(response, 200, await facilitator.settle(body));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "unexpected_error"
      });
    }
  });
}
