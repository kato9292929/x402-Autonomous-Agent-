/**
 * Per-endpoint response samples: selection (newest, prefer captured body),
 * trimming (stays valid JSON), and the no-fabrication rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamples, trimSample, pathOf, SAMPLE_CHAR_CAP } from "../store/samples";
import type { RunLog } from "../types";

function run(timestamp: string, results: RunLog["results"]): RunLog {
  return {
    timestamp,
    mode: "B",
    results,
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 0,
    errors: [],
  };
}

test("pathOf: URL からパスだけを取り出す", () => {
  assert.equal(pathOf("https://osd.x402jp.com/api/alpha/jp/scorecard"), "/api/alpha/jp/scorecard");
  assert.equal(pathOf("x402oif.vercel.app/api/feed/apac-daily"), "/api/feed/apac-daily");
});

test("buildSamples: 実際に返ってきた本文をそのまま出す(捏造しない)", () => {
  const runs = [
    run("2026-08-18T06:00:00Z", [
      {
        endpoint: "https://jin.x402jp.com/api/jin/movers",
        product: "JIN Movers",
        status: "success",
        costUsdc: 0.02,
        responsePeek: "12 movers",
        durationMs: 10,
        txHash: "0xabc",
        fullData: { movers: [{ name: "卵", pct: 3.2 }] },
      },
    ]),
  ];
  const [s] = buildSamples(runs);
  assert.equal(s.path, "/api/jin/movers");
  assert.deepEqual(s.sample, { movers: [{ name: "卵", pct: 3.2 }] });
  assert.equal(s.txHash, "0xabc");
  assert.equal(s.truncated, undefined);
});

test("buildSamples: 本文が無い endpoint には sample を作らない(peek だけ残る)", () => {
  const runs = [
    run("2026-08-18T06:00:00Z", [
      {
        endpoint: "https://x402yi.vercel.app/api/yield/scan",
        product: "Yield",
        status: "degraded",
        costUsdc: 0.2,
        responsePeek: "source=sample-data",
        degradedReason: "source=sample-data",
        durationMs: 10,
      },
    ]),
  ];
  const [s] = buildSamples(runs);
  assert.equal(s.sample, undefined); // 空オブジェクトをでっち上げない
  assert.equal(s.peek, "source=sample-data");
  assert.equal(s.status, "degraded");
});

test("buildSamples: 本文を持つ結果が、新しいだけの空の結果より優先される", () => {
  const runs = [
    run("2026-08-17T06:00:00Z", [
      { endpoint: "u", product: "P", status: "success", costUsdc: 0, responsePeek: "old", durationMs: 1, fullData: { v: 1 } },
    ]),
    run("2026-08-18T06:00:00Z", [
      { endpoint: "u", product: "P", status: "error", costUsdc: 0, responsePeek: "", durationMs: 1, error: "boom" },
    ]),
  ];
  const [s] = buildSamples(runs);
  assert.deepEqual(s.sample, { v: 1 });
  assert.equal(s.at, "2026-08-17T06:00:00Z");
});

test("buildSamples: 本文が両方にあるなら新しい方を採る", () => {
  const runs = [
    run("2026-08-17T06:00:00Z", [
      { endpoint: "u", product: "P", status: "success", costUsdc: 0, responsePeek: "", durationMs: 1, fullData: { v: "old" } },
    ]),
    run("2026-08-18T06:00:00Z", [
      { endpoint: "u", product: "P", status: "success", costUsdc: 0, responsePeek: "", durationMs: 1, fullData: { v: "new" } },
    ]),
  ];
  const [s] = buildSamples(runs);
  assert.deepEqual(s.sample, { v: "new" });
});

test("trimSample: 上限を超える配列は要素単位で切り、有効な JSON のままにする", () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ i, pad: "xxxxxxxxxx" }));
  const { value, truncated } = trimSample(big);
  assert.equal(truncated, true);
  assert.ok(Array.isArray(value));
  const json = JSON.stringify(value);
  assert.ok(json.length <= SAMPLE_CHAR_CAP, `got ${json.length}`);
  assert.doesNotThrow(() => JSON.parse(json)); // 文字列途中で切っていない
  assert.deepEqual(value[0], { i: 0, pad: "xxxxxxxxxx" }); // 先頭は原文のまま
});

test("trimSample: 上限内ならそのまま返す", () => {
  const small = { a: 1, b: "two" };
  const { value, truncated } = trimSample(small);
  assert.deepEqual(value, small);
  assert.equal(truncated, false);
});
