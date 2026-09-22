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

// ── 2026-09 の CDP 無料枠ブロック障害の再発防止 ─────────────────────────────
// 実ログでは理由が 160 字で切れ、`{"errorMessage":"A val` の直後で原因の文が
// 消えていた。原因特定が4日遅れた直接の理由なので、行が切れないことを固定する。

/** 障害時に実際に返ってきたボディ（caller.ts が付ける接頭辞つき）。 */
const CDP_SETTLE_ERROR =
  'HTTP 402: {"x402Version":2,"error":"facilitator settle error: HTTP 402 Payment ' +
  'Required for https://api.cdp.coinbase.com/platform/v2/x402/settle: ' +
  '{\\"correlationId\\":\\"a3db855dad2e98e4-IAD\\",\\"errorLink\\":' +
  '\\"https://docs.cdp.coinbase.com/api-reference/v2/errors#payment-method-required\\",' +
  '\\"errorMessage\\":\\"A valid payment method is required to continue using this ' +
  'product beyond the free tier.\\"}"}';

function runWithError(error: string): RunLog {
  return {
    timestamp: "2026-09-20T21:00:40Z",
    mode: "B",
    results: [
      {
        endpoint: "https://x402odo.vercel.app/api/funding/nowcast",
        product: "ODO Onchain Funding Nowcast",
        status: "error",
        costUsdc: 0,
        responsePeek: "",
        error,
        durationMs: 2000,
      },
    ],
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 2000,
    errors: [`ODO Onchain Funding Nowcast: ${error}`],
  };
}

test("formatRunSummary: facilitator の errorMessage を切り落とさない", () => {
  const out = formatRunSummary(runWithError(CDP_SETTLE_ERROR)).join("\n");
  assert.ok(out.includes("payment-method-required"), "errorLink が切れている");
  assert.ok(
    out.includes("A valid payment method is required"),
    "原因そのものの errorMessage が切れている"
  );
});

test("formatRunSummary: 失敗行と errors 行の両方で理由が残る", () => {
  const lines = formatRunSummary(runWithError(CDP_SETTLE_ERROR));
  const resultLine = lines.find((l) => l.includes("✗ ODO"));
  const errorLine = lines.find((l) => l.startsWith("[RUN]  ! "));
  assert.ok(resultLine?.includes("A valid payment method is required"));
  assert.ok(errorLine?.includes("A valid payment method is required"));
});

test("formatRunSummary: 理由が無制限に伸びることはない", () => {
  const huge = "x".repeat(50_000);
  const [, line] = formatRunSummary(runWithError(huge));
  assert.ok(line.length < 2000, `1行が長すぎる: ${line.length}`);
  assert.ok(line.endsWith("…"), "切り詰めたことが示されていない");
});

test("formatRunSummary: responsePeek 側は短いまま（ログ量を増やさない）", () => {
  const log = runWithError("boom");
  log.results[0] = {
    ...log.results[0],
    status: "success",
    error: undefined,
    responsePeek: "p".repeat(5000),
  };
  const [, line] = formatRunSummary(log);
  assert.ok(line.length < 400, `peek が長すぎる: ${line.length}`);
});

test("formatRunSummary: 実決済ネットワークを行に出す", () => {
  const log = runWithError("boom");
  log.results[0] = {
    ...log.results[0],
    status: "success",
    error: undefined,
    txHash: "2Mur8SJ",
    settledNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  };
  const [, line] = formatRunSummary(log);
  assert.match(line, /via=solana:/);
});
