/**
 * MXE record helpers, flags and the append-only store (local-JSONL path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  aggregateByFunction,
  aggregateSearchBySize,
  unitCostRatio,
  type MxeTradeRecord,
} from "../mxe/record";
import { functionEnabled, mxeJobEnabled, mxeNetwork } from "../mxe/flags";
import { loadMxeRecords, saveMxeRecord } from "../store/mxe-store";

const base = (over: Partial<MxeTradeRecord>): MxeTradeRecord => ({
  at: "2026-10-21T00:00:00.000Z",
  fn: 1,
  label: "x",
  status: "ok",
  network: "arcium-devnet",
  counterparty: "internal",
  ...over,
});

test("unitCostRatio needs a positive trade and a non-negative cost", () => {
  assert.equal(unitCostRatio(0.002, 0.01), 0.2);
  assert.equal(unitCostRatio(0, 0.01), 0);
  assert.equal(unitCostRatio(0.002, 0), undefined);
  assert.equal(unitCostRatio(undefined, 0.01), undefined);
  assert.equal(unitCostRatio(-1, 0.01), undefined);
});

test("aggregates count only ok runs toward time, cost and ratio", () => {
  const agg = aggregateByFunction([
    base({ latencyMs: 1000, costUsd: 0.01, costSol: 0.0001, unitCostRatio: 1, comparison: { method: "public", result: 1 } }),
    base({ latencyMs: 3000, costUsd: 0.03, costSol: 0.0003, unitCostRatio: 3 }),
    base({ status: "failed", latencyMs: 99999, error: "boom" }),
    base({ fn: 5, status: "disabled", counterparty: "self" }),
  ]);
  const f1 = agg[0];
  assert.equal(f1.runs, 3);
  assert.equal(f1.ok, 2);
  assert.equal(f1.failed, 1);
  assert.deepEqual(f1.latencyMs, { mean: 2000, min: 1000, max: 3000, n: 2 });
  assert.ok(Math.abs(f1.costUsd!.total - 0.04) < 1e-12);
  assert.equal(f1.unitCostRatio!.mean, 2);
  assert.equal(f1.compared, 1);
  assert.deepEqual(f1.networks, ["arcium-devnet"]);
  assert.equal(agg[4].disabled, 1);
  assert.equal(agg[4].latencyMs, undefined);
  assert.equal(agg.length, 5);
});

test("flags are off unless set to exactly \"true\"", () => {
  assert.equal(mxeJobEnabled({}), false);
  assert.equal(mxeJobEnabled({ MXE_ENABLED: "true" }), true);
  assert.equal(functionEnabled(3, { MXE_F3_ENABLED: "true" }), true);
  assert.equal(functionEnabled(3, { MXE_F3_ENABLED: "1" }), false);
  assert.equal(functionEnabled(4, { MXE_F3_ENABLED: "true" }), false);
});

test("network defaults to devnet and rejects unknown values", () => {
  assert.equal(mxeNetwork({}), "arcium-devnet");
  assert.equal(mxeNetwork({ MXE_NETWORK: "arcium-mainnet" }), "arcium-mainnet");
  assert.throws(() => mxeNetwork({ MXE_NETWORK: "mainnet" }));
});

test("store appends and loads newest first from local JSONL", async () => {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mxe-store-"));
  const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.chdir(tmp);
  try {
    await saveMxeRecord(base({ fn: 1, at: "a" }));
    await saveMxeRecord(base({ fn: 2, at: "b" }));
    fs.appendFileSync(path.join(tmp, "data", "mxe", "mxe-trades.jsonl"), "{truncated\n");
    await saveMxeRecord(base({ fn: 3, at: "c" }));
    const all = await loadMxeRecords();
    assert.deepEqual(all.map((r) => r.at), ["c", "b", "a"]);
    assert.deepEqual((await loadMxeRecords(2)).map((r) => r.at), ["c", "b"]);
  } finally {
    process.chdir(cwd);
    if (saved.url) process.env.UPSTASH_REDIS_REST_URL = saved.url;
    if (saved.token) process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
  }
});

test("function 5 aggregates by catalog size, from CU and fees per computation", () => {
  const rec = (n: number, cu: string, fee: number, costSol: number, status: "ok" | "failed" = "ok") =>
    base({ fn: 5, status, counterparty: "self", costSol, latencyMs: 4000, result: { catalogSize: n },
      computations: [{ circuit: `search_catalog_${n}`, offset: "1", account: "a", queueTx: "t", cuAmount: cu, baseFeeLamports: fee }] });
  const agg = aggregateSearchBySize([
    rec(64, "469882772", 300, 0.00002),
    rec(8, "432675748", 100, 0.00001),
    rec(8, "432675748", 200, 0.00003),
    rec(8, "432675748", 999, 9, "failed"),
    base({ fn: 1 }),
  ]);
  assert.deepEqual(agg.map((a) => a.catalogSize), [8, 64]);
  assert.equal(agg[0].runs, 2);
  assert.equal(agg[0].cuAmount, "432675748");
  assert.equal(agg[0].baseFeeLamports, 150);
  assert.ok(Math.abs(agg[0].costSol! - 0.00002) < 1e-12);
  assert.equal(agg[1].cuAmount, "469882772");
});
