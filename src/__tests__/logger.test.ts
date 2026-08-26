/**
 * The run summary must stay compact and must never print fullData — that dump
 * is what pushed Railway past its 500 logs/sec limit and dropped messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRunSummary } from "../logger";
import type { RunLog } from "../types";

function bigRun(): RunLog {
  return {
    timestamp: "2026-08-26T06:00:10+09:00",
    mode: "B",
    results: Array.from({ length: 12 }, (_, i) => ({
      endpoint: `https://example.com/api/${i}`,
      product: `Product ${i}`,
      status: i === 11 ? ("error" as const) : ("success" as const),
      costUsdc: 0.01,
      responsePeek: "peek",
      durationMs: 100,
      txHash: i === 11 ? undefined : `0xtx${i}`,
      error: i === 11 ? "boom" : undefined,
      // A large captured body, as Mode B/D actually produce.
      fullData: { secretlyHuge: Array.from({ length: 2000 }, (_, k) => ({ k, pad: "yyyyyyyyyy" })) },
    })),
    totalCostUsdc: 0.12,
    totalTxCount: 11,
    totalDegradedCount: 0,
    durationMs: 34000,
    errors: ["Product 11: boom"],
  };
}

test("formatRunSummary: fullData は一切出力しない", () => {
  const out = formatRunSummary(bigRun()).join("\n");
  assert.ok(!out.includes("secretlyHuge"), "fullData のキーが漏れている");
  assert.ok(!out.includes("yyyyyyyyyy"), "fullData の中身が漏れている");
});

test("formatRunSummary: 行数は 1 + endpoint 数 + errors 数に収まる", () => {
  const lines = formatRunSummary(bigRun());
  // 1 header + 12 results + 1 error = 14。数千行にならないこと。
  assert.equal(lines.length, 14);
});

test("formatRunSummary: ヘッダに集計と費用が載る", () => {
  const [header] = formatRunSummary(bigRun());
  assert.match(header, /mode=B/);
  assert.match(header, /ok=11/);
  assert.match(header, /error=1/);
  assert.match(header, /cost=\$0\.120/);
});

test("formatRunSummary: 成功行に tx、失敗行に理由が出る", () => {
  const out = formatRunSummary(bigRun());
  assert.ok(out.some((l) => l.includes("✓ Product 0") && l.includes("tx=0xtx0")));
  assert.ok(out.some((l) => l.includes("✗ Product 11") && l.includes("boom")));
});

test("formatRunSummary: 空の run でも落ちない", () => {
  const empty: RunLog = {
    timestamp: "2026-08-26T06:00:00Z",
    mode: "A",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 0,
    errors: [],
  };
  assert.equal(formatRunSummary(empty).length, 1);
});
