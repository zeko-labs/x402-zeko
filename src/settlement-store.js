import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function getFetch(fetchImpl) {
  const resolved = fetchImpl ?? globalThis.fetch;

  if (typeof resolved !== "function") {
    throw new Error("fetch implementation is required.");
  }

  return resolved;
}

function normalizeEntry(entry) {
  return {
    paymentKey: assertNonEmptyString("entry.paymentKey", entry?.paymentKey),
    paymentLeaf: assertNonEmptyString("entry.paymentLeaf", entry?.paymentLeaf),
    ...(typeof entry?.requestId === "string" && entry.requestId.length > 0
      ? { requestId: entry.requestId }
      : {}),
    ...(typeof entry?.paymentId === "string" && entry.paymentId.length > 0
      ? { paymentId: entry.paymentId }
      : {}),
    ...(typeof entry?.txHash === "string" && entry.txHash.length > 0 ? { txHash: entry.txHash } : {}),
    ...(typeof entry?.settledAtIso === "string" && entry.settledAtIso.length > 0
      ? { settledAtIso: entry.settledAtIso }
      : {}),
    ...(isRecord(entry?.metadata) ? { metadata: entry.metadata } : {})
  };
}

export function emptySettlementStore() {
  return {
    version: 1,
    entries: []
  };
}

export async function readSettlementStore(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: parsed?.version ?? 1,
      entries: Array.isArray(parsed?.entries) ? parsed.entries.map((entry) => normalizeEntry(entry)) : []
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptySettlementStore();
    }

    throw error;
  }
}

export async function writeSettlementStore(statePath, store) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: store?.version ?? 1,
        entries: Array.isArray(store?.entries) ? store.entries.map((entry) => normalizeEntry(entry)) : []
      },
      null,
      2
    )
  );
}

export async function recordSettlementEntry(statePath, entry) {
  const store = await readSettlementStore(statePath);
  const normalized = normalizeEntry(entry);
  const existingIndex = store.entries.findIndex((candidate) => candidate.paymentKey === normalized.paymentKey);

  if (existingIndex >= 0) {
    store.entries[existingIndex] = {
      ...store.entries[existingIndex],
      ...normalized
    };
  } else {
    store.entries.push(normalized);
  }

  await writeSettlementStore(statePath, store);
  return store;
}

export async function persistSettlementWitnessUpdate(statePath, update, metadata = {}) {
  return await recordSettlementEntry(statePath, {
    paymentKey: update?.paymentKey,
    paymentLeaf: update?.paymentLeaf,
    ...(typeof metadata?.requestId === "string" ? { requestId: metadata.requestId } : {}),
    ...(typeof metadata?.paymentId === "string" ? { paymentId: metadata.paymentId } : {}),
    ...(typeof metadata?.txHash === "string" ? { txHash: metadata.txHash } : {}),
    settledAtIso: metadata?.settledAtIso ?? new Date().toISOString(),
    ...(isRecord(metadata) ? { metadata } : {})
  });
}

export async function recordSettlementWitnessUpdate(target, update, metadata = {}, input = {}) {
  if (typeof target === "string" && !/^https?:\/\//i.test(target)) {
    return await persistSettlementWitnessUpdate(target, update, metadata);
  }

  const baseUrl = assertNonEmptyString(
    "target",
    typeof target === "string" ? target : target?.baseUrl
  ).replace(/\/+$/, "");
  const fetchImpl = getFetch(input?.fetchImpl ?? target?.fetchImpl);
  const response = await fetchImpl(`${baseUrl}/record`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(target?.headers ?? {}),
      ...(input?.headers ?? {})
    },
    body: JSON.stringify({
      paymentKey: update?.paymentKey,
      paymentLeaf: update?.paymentLeaf,
      ...(typeof metadata?.requestId === "string" ? { requestId: metadata.requestId } : {}),
      ...(typeof metadata?.paymentId === "string" ? { paymentId: metadata.paymentId } : {}),
      ...(typeof metadata?.txHash === "string" ? { txHash: metadata.txHash } : {}),
      ...(typeof metadata?.settledAtIso === "string" ? { settledAtIso: metadata.settledAtIso } : {}),
      ...(isRecord(metadata?.metadata) ? { metadata: metadata.metadata } : {})
    })
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.error ?? `Witness record request failed (${response.status}).`);
  }

  return body;
}

export function buildSettlementMerkleMap(o1js, store) {
  const { Field, MerkleMap } = o1js;
  const map = new MerkleMap();

  for (const entry of Array.isArray(store?.entries) ? store.entries : []) {
    map.set(Field(entry.paymentKey), Field(entry.paymentLeaf));
  }

  return map;
}

export function computeSettlementStoreRoot(o1js, store) {
  return buildSettlementMerkleMap(o1js, store).getRoot();
}

export function serializeMerkleMapWitness(witness) {
  return {
    isLefts: witness.isLefts.map((entry) =>
      typeof entry?.toBoolean === "function" ? entry.toBoolean() : Boolean(entry)
    ),
    siblings: witness.siblings.map((entry) =>
      typeof entry?.toString === "function" ? entry.toString() : String(entry)
    )
  };
}

export function deserializeMerkleMapWitness(o1js, payload) {
  return new o1js.MerkleMapWitness(
    payload.isLefts.map((entry) => o1js.Bool(entry)),
    payload.siblings.map((entry) => o1js.Field(entry))
  );
}

export function createFileBackedSettlementWitnessProvider(input) {
  const statePath = assertNonEmptyString("statePath", input?.statePath);

  return async function provideWitness(context) {
    const store = await readSettlementStore(statePath);
    const map = buildSettlementMerkleMap(context.o1js, store);

    return {
      witness: map.getWitness(context.paymentKey),
      currentRoot: map.getRoot(),
      statePath
    };
  };
}

export function createHttpSettlementWitnessProvider(input) {
  const baseUrl = assertNonEmptyString("baseUrl", input?.baseUrl).replace(/\/+$/, "");
  const fetchImpl = getFetch(input?.fetchImpl);

  return async function provideWitness(context) {
    const response = await fetchImpl(`${baseUrl}/witness`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input?.headers ?? {})
      },
      body: JSON.stringify({
        paymentKey: String(context.paymentKey)
      })
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(body?.error ?? `Witness service request failed (${response.status}).`);
    }

    return {
      witness: deserializeMerkleMapWitness(context.o1js, body.witness),
      currentRoot: body.currentRoot ?? null
    };
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createSettlementWitnessHttpServer(input) {
  const statePath = assertNonEmptyString("statePath", input?.statePath);
  const loadO1js = input?.loadO1js;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const o1js = typeof loadO1js === "function" ? await loadO1js() : await import("o1js");
      const store = await readSettlementStore(statePath);

      if (request.method === "GET" && url.pathname === "/root") {
        sendJson(response, 200, {
          ok: true,
          currentRoot: computeSettlementStoreRoot(o1js, store).toString(),
          entryCount: store.entries.length
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/witness") {
        const body = await readJsonBody(request);
        const paymentKey = assertNonEmptyString("paymentKey", body?.paymentKey);
        const map = buildSettlementMerkleMap(o1js, store);
        const witness = map.getWitness(o1js.Field(paymentKey));

        sendJson(response, 200, {
          ok: true,
          currentRoot: map.getRoot().toString(),
          witness: serializeMerkleMapWitness(witness)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/record") {
        const body = await readJsonBody(request);
        const updatedStore = await recordSettlementEntry(statePath, {
          paymentKey: body?.paymentKey,
          paymentLeaf: body?.paymentLeaf,
          ...(typeof body?.requestId === "string" ? { requestId: body.requestId } : {}),
          ...(typeof body?.paymentId === "string" ? { paymentId: body.paymentId } : {}),
          ...(typeof body?.txHash === "string" ? { txHash: body.txHash } : {}),
          ...(typeof body?.settledAtIso === "string" ? { settledAtIso: body.settledAtIso } : {}),
          ...(isRecord(body?.metadata) ? { metadata: body.metadata } : {})
        });

        sendJson(response, 200, {
          ok: true,
          currentRoot: computeSettlementStoreRoot(o1js, updatedStore).toString(),
          entryCount: updatedStore.entries.length
        });
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
