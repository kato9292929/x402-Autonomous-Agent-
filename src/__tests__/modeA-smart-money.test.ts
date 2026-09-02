/**
 * Mode A, Smart Money Screener 起点。
 *
 * 課金が絡む変更なので「叩かなかったこと」を明示的に固定する: Mode A は
 * Whale Intent Decoder を呼ばず、そもそも支払い fetch を一度も使わない。
 *
 * runModeA は process.cwd() 配下に記録を書くので、ファイル全体を一時ディレクトリで走らせる。
 * chdir はロード時に行い、modeA の動的 import より前に済ませる。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ENDPOINTS_MODE_B } from "../config";
import type { RunLog } from "../types";
import type { DecisionRecord } from "../store/decision-store";

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-modea-sms-"));
process.chdir(TMP);

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const SMS_URL = ENDPOINTS_MODE_B.find((e) => e.id === "smart-money-screener")!.url;

/** Mode B のログ。Smart Money Screener の応答だけを載せる。 */
function modeBLogWith(body: unknown, peek = ""): RunLog {
  return {
    timestamp: new Date().toISOString(),
    mode: "B",
    results: [
      {
        endpoint: SMS_URL,
        product: "Smart Money Screener",
        status: "success",
        costUsdc: 0.05,
        responsePeek: peek,
        durationMs: 1,
        fullData: body as Record<string, unknown>,
      },
    ],
    totalCostUsdc: 0.05,
    totalTxCount: 1,
    totalDegradedCount: 0,
    durationMs: 1,
    errors: [],
  };
}

/** Mode A を走らせ、支払い fetch の呼び出し回数と記録された decision を返す。 */
async function runWithPaymentWatch(
  modeBLog?: RunLog
): Promise<{ paidCalls: number; record: DecisionRecord }> {
  const x402 = (await import("../x402")) as { fetchWithPayment: unknown };
  const { runModeA } = await import("../modes/modeA");

  let paidCalls = 0;
  const previous = x402.fetchWithPayment;
  x402.fetchWithPayment = async () => {
    paidCalls += 1;
    return new Response("{}", { status: 200 });
  };

  const jsonl = path.join(TMP, "data", "decisions", "mode-a-decisions.jsonl");
  fs.rmSync(jsonl, { force: true });
  try {
    await runModeA(modeBLog);
  } finally {
    x402.fetchWithPayment = previous;
  }

  const lines = fs.readFileSync(jsonl, "utf-8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "1 run につき decision は1件");
  return { paidCalls, record: JSON.parse(lines[0]) as DecisionRecord };
}

/** 実際の掲載カラム: RANK / TOKEN / CHAIN / SM WALLETS / NET FLOW(24h) / SCORE */
function screenerBody(tokens: Array<Record<string, unknown>>): Record<string, unknown> {
  return { total_scanned: tokens.length, tokens, warnings: [] };
}

// ── 課金しない ───────────────────────────────────────────────────────────────

test("Mode A は支払い fetch を一度も使わない(Whale Intent Decoder 呼び出し0・課金0)", async () => {
  const { paidCalls, record } = await runWithPaymentWatch(
    modeBLogWith(
      screenerBody([
        { rank: 1, token: "AERO", chain: "base", smWallets: 14, netFlow24h: 5_200_000, score: 82 },
      ])
    )
  );
  assert.equal(paidCalls, 0);
  assert.equal(record.costUsdc, 0);
  assert.equal(record.executed, false);
});

// ── 候補選定 ─────────────────────────────────────────────────────────────────

test("閾値を満たす行から候補と方向(net flow の符号)を出す", async () => {
  const { record } = await runWithPaymentWatch(
    modeBLogWith(
      screenerBody([
        { rank: 1, token: "AERO", chain: "base", smWallets: 14, netFlow24h: 5_200_000, score: 82 },
        { rank: 2, token: "DEGEN", chain: "base", smWallets: 9, netFlow24h: -1_100_000, score: 61 },
      ])
    )
  );
  assert.equal(record.signals.smartMoney.available, true);
  assert.equal(record.signals.smartMoney.rowCount, 2);
  assert.equal(record.signals.smartMoney.token, "AERO"); // score が最大
  assert.equal(record.signals.smartMoney.netFlowUsd, 5_200_000);
  assert.equal(record.signals.smartMoney.smWallets, 14);
  assert.equal(record.signals.smartMoney.scoreScale, 100);
  assert.equal(record.call.direction, "long");
  assert.equal(record.call.action, "BUY");
  assert.ok(record.score > 0);
  assert.equal(record.executed, false);
});

test("net flow が流出なら short 方向として記録する", async () => {
  const { record } = await runWithPaymentWatch(
    modeBLogWith(
      screenerBody([
        { rank: 1, token: "DEGEN", chain: "base", smWallets: 9, netFlow24h: -8_000_000, score: 74 },
      ])
    )
  );
  assert.equal(record.call.direction, "short");
  assert.ok(record.score < 0);
});

test("screener が空なら SKIP(候補を作らない)", async () => {
  const { paidCalls, record } = await runWithPaymentWatch(
    modeBLogWith({ tokens: [], total_scanned: 0, warnings: ["solana: Nansen does not appear to support"] })
  );
  assert.equal(paidCalls, 0);
  assert.equal(record.signals.smartMoney.available, false);
  assert.equal(record.signals.smartMoney.rowCount, 0);
  assert.equal(record.call.action, "SKIP");
  assert.equal(record.call.direction, "neutral");
  assert.equal(record.score, 0);
  assert.equal(record.call.sizeUsdProposal, 0);
});

test("Mode B のログが無くても1件は記録して落ちない", async () => {
  const { paidCalls, record } = await runWithPaymentWatch(undefined);
  assert.equal(paidCalls, 0);
  assert.equal(record.signals.smartMoney.source, "unavailable");
  assert.equal(record.call.action, "SKIP");
});

test("閾値は env で調整できる(満たさなければ SKIP)", async () => {
  process.env.SMS_MIN_SCORE = "90";
  try {
    const { record } = await runWithPaymentWatch(
      modeBLogWith(
        screenerBody([
          { rank: 1, token: "AERO", chain: "base", smWallets: 14, netFlow24h: 5_200_000, score: 82 },
        ])
      )
    );
    assert.equal(record.signals.smartMoney.available, false);
    assert.equal(record.signals.smartMoney.rowCount, 1, "行はあるが閾値未満");
    assert.equal(record.call.action, "SKIP");
  } finally {
    delete process.env.SMS_MIN_SCORE;
  }
});

// ── 設定 ─────────────────────────────────────────────────────────────────────

test("Hyperliquid Intelligence は Mode B からも外れている(fetch 停止)", () => {
  assert.equal(
    ENDPOINTS_MODE_B.some((e) => e.id === "hyperliquid-intelligence"),
    false
  );
});

test("Smart Money Screener は Base を叩き、本文を保存する", () => {
  const ep = ENDPOINTS_MODE_B.find((e) => e.id === "smart-money-screener")!;
  assert.match(ep.url, /chain=base/);
  assert.equal(ep.captureFullData, true, "Mode A が行を読むには本文が要る");
});
