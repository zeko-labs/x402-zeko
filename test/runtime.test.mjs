import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  fetchZekoTransactionStatus,
  readSettlementStore,
  recordSettlementWitnessUpdate,
  waitForZekoTransaction
} from "../src/index.js";

test("recordSettlementWitnessUpdate persists locally and can target an HTTP witness service", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "zeko-x402-runtime-"));
  const statePath = path.join(tmpDir, "settlement-state.json");

  const localStore = await recordSettlementWitnessUpdate(
    statePath,
    {
      paymentKey: "101",
      paymentLeaf: "202"
    },
    {
      requestId: "req_runtime_001",
      paymentId: "pay_runtime_001",
      txHash: "5Jruntime001"
    }
  );
  const stored = await readSettlementStore(statePath);

  assert.equal(localStore.entries.length, 1);
  assert.equal(stored.entries[0].paymentKey, "101");
  assert.equal(stored.entries[0].txHash, "5Jruntime001");

  let postedBody = null;
  const remote = await recordSettlementWitnessUpdate(
    "https://witness.example",
    {
      paymentKey: "303",
      paymentLeaf: "404"
    },
    {
      requestId: "req_runtime_002",
      paymentId: "pay_runtime_002",
      txHash: "5Jruntime002"
    },
    {
      fetchImpl: async (url, init) => {
        postedBody = JSON.parse(String(init.body));
        assert.equal(url, "https://witness.example/record");
        return new Response(
          JSON.stringify({
            ok: true,
            currentRoot: "root:303=404",
            entryCount: 1
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );

  assert.equal(postedBody.paymentKey, "303");
  assert.equal(postedBody.paymentLeaf, "404");
  assert.equal(postedBody.txHash, "5Jruntime002");
  assert.equal(remote.entryCount, 1);
});

test("fetchZekoTransactionStatus falls back across query variants", async () => {
  const result = await fetchZekoTransactionStatus("5Jtxhash001", {
    endpoint: "https://testnet.zeko.example/graphql",
    fetchImpl: async (_url, init) => {
      const { query } = JSON.parse(String(init.body));

      if (query.includes("transactionStatus(zkappTransaction")) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "Field 'transactionStatus' is not defined on type 'query'" }]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (query.includes("transaction(hash:$hash)")) {
        return new Response(
          JSON.stringify({
            data: {
              transaction: {
                hash: "5Jtxhash001",
                canonical: true,
                blockHeight: 123
              }
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected query: ${query}`);
    }
  });

  assert.equal(result.found, true);
  assert.equal(result.status, "included");
  assert.equal(result.variant, "transaction(hash)");
  assert.equal(result.attempts.length, 2);
});

test("waitForZekoTransaction accepts a later successful poll", async () => {
  let cycle = 0;

  const result = await waitForZekoTransaction("5Jtxhash002", {
    endpoint: "https://testnet.zeko.example/graphql",
    attempts: 2,
    pollIntervalMs: 1,
    fetchImpl: async (_url, init) => {
      const { query } = JSON.parse(String(init.body));

      if (query.includes("transactionStatus(zkappTransaction")) {
        cycle += 1;
        return new Response(
          JSON.stringify({
            data: {
              transactionStatus: cycle >= 2 ? "included" : null
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (query.includes("transaction(hash:$hash)")) {
        return new Response(
          JSON.stringify({
            data: {
              transaction: null
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (query.includes("transactionStatus(payment:$hash)")) {
        return new Response(
          JSON.stringify({
            data: {
              transactionStatus: null
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected query: ${query}`);
    }
  });

  assert.equal(result.accepted, true);
  assert.equal(result.status, "included");
});
