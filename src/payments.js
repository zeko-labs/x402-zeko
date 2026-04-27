import { buildPaymentPayload } from "./protocol.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

export const ZEKO_SEND_ZKAPP_MUTATION = `
mutation sendZkapp($zkappCommandInput: ZkappCommandInput!) {
  sendZkapp(input: { zkappCommand: $zkappCommandInput }) {
    zkapp {
      hash
      id
      failureReason { failures }
    }
  }
}
`.trim();

export function buildSignedEvmAuthorization(intent, input) {
  const signature = assertNonEmptyString("signature", input?.signature);

  if (!isRecord(intent?.typedData)) {
    throw new Error("EVM intent must include typedData.");
  }

  return {
    primitive: assertNonEmptyString("intent.primitive", intent.primitive),
    settlementRail: "evm",
    network: intent.network,
    asset: intent.asset,
    transferMethod: intent.transferMethod,
    facilitator: intent.facilitator ?? null,
    typedData: intent.typedData,
    signature,
    ...(isRecord(intent.settlement) ? { settlement: intent.settlement } : {}),
    ...(isRecord(intent.paymentPayloadShape) ? { paymentPayloadShape: intent.paymentPayloadShape } : {})
  };
}

export function buildSignedZekoNativePaymentAuthorization(intent, input) {
  const signedPayment = input?.signedPayment;
  const graphql = intent?.graphql;

  if (!isRecord(graphql)) {
    throw new Error("Zeko native payment intent must include graphql submission details.");
  }

  const signature = isRecord(signedPayment?.signature)
    ? signedPayment.signature
    : isRecord(input?.signature)
      ? input.signature
      : typeof input?.rawSignature === "string" && input.rawSignature.length > 0
        ? { rawSignature: input.rawSignature }
        : undefined;

  if (!isRecord(signature)) {
    throw new Error("A signed Zeko native payment requires signature or signedPayment.signature.");
  }

  const paymentInput = isRecord(signedPayment?.data)
    ? signedPayment.data
    : isRecord(input?.paymentInput)
      ? input.paymentInput
      : graphql.variables?.input;

  if (!isRecord(paymentInput)) {
    throw new Error("A signed Zeko native payment requires payment input data.");
  }

  return {
    primitive: assertNonEmptyString("intent.primitive", intent.primitive),
    settlementRail: "zeko",
    network: intent.network,
    graphql: {
      endpoint: graphql.endpoint,
      operationName: graphql.operationName,
      query: graphql.query,
      variables: {
        input: paymentInput,
        signature
      }
    },
    signature
  };
}

export function buildSignedZekoZkappAuthorization(intent, input) {
  const zkappCommandLike = input?.zkappCommand ?? input?.signedTransactionJson;
  const zkappCommand =
    typeof zkappCommandLike === "string"
      ? JSON.parse(zkappCommandLike)
      : zkappCommandLike;

  if (!isRecord(zkappCommand)) {
    throw new Error("zkappCommand is required.");
  }

  const graphqlEndpoint = input?.endpoint ?? intent?.network?.graphql;

  return {
    primitive: assertNonEmptyString("intent.primitive", intent?.primitive),
    settlementRail: "zeko",
    network: intent.network,
    transaction: intent.transaction,
    accountUpdates: intent.accountUpdates,
    settlementVerification: intent.settlementVerification,
    zkappCommand,
    submission: {
      kind: "graphql",
      endpoint: assertNonEmptyString("endpoint", graphqlEndpoint),
      operationName: "sendZkapp",
      query: ZEKO_SEND_ZKAPP_MUTATION,
      variables: {
        zkappCommandInput: zkappCommand
      }
    },
    ...(isRecord(input?.settlementWitnessUpdate)
      ? { settlementWitnessUpdate: input.settlementWitnessUpdate }
      : {})
  };
}

export function buildSignedPaymentPayload(input) {
  return buildPaymentPayload(input);
}
