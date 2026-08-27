/**
 * Mode A's Whale Intent Decoder gate.
 *
 * The gate used to read the Divergence Analyzer alone, which has returned an
 * empty `results` array on every run, so the Decoder never fired. Hyperliquid —
 * already bought each day by Mode B — is now a second source for the same gate.
 * These tests pin the behaviour that costs money: how many times the Decoder is
 * POSTed, and that a decode never turns into an execution.
 *
 * runModeA persists to data/ under process.cwd(), so the whole file runs inside
 * a temp directory. The chdir happens at load time, before modeA is imported.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-modea-gate-"));
process.chdir(TMP);

// Both stores would otherwise write to the real Upstash list.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const HL_URL = ENDPOINTS_MODE_B.find((e) => e.id === "hyperliquid-intelligence")!.url;

/** A Mode B log carrying only the Hyperliquid result (Divergence Analyzer empty). */
function modeBLogWith(topDivergences: unknown[]): RunLog {
  return {
    timestamp: new Date().toISOString(),
    mode: "B",
    results: [
      {
        endpoint: HL_URL,
        product: "Hyperliquid Intelligence",
        status: "success",
        costUsdc: 0.2,
        responsePeek: "",
        durationMs: 1,
        fullData: { scannedTokens: 15, topDivergences },
      },
    ],
    totalCostUsdc: 0.2,
    totalTxCount: 1,
    totalDegradedCount: 0,
    durationMs: 1,
    errors: [],
  };
}

interface DecodeCall {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Run Mode A with the paid fetch replaced. Returns every Decoder call made,
 * plus the decision record that was appended.
 */
async function runWithStubbedPayment(
  modeBLog: RunLog,
  respond: () => Response
): Promise<{ calls: DecodeCall[]; record: DecisionRecord }> {
  const x402 = (await import("../x402")) as { fetchWithPayment: unknown };
  const { runModeA } = await import("../modes/modeA");

  const calls: DecodeCall[] = [];
  const previous = x402.fetchWithPayment;
  x402.fetchWithPayment = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return respond();
  };

  const jsonl = path.join(TMP, "data", "decisions", "mode-a-decisions.jsonl");
  fs.rmSync(jsonl, { force: true });
  try {
    await runModeA(modeBLog);
  } finally {
    x402.fetchWithPayment = previous;
  }

  const lines = fs.readFileSync(jsonl, "utf-8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "exactly one decision per run");
  return { calls, record: JSON.parse(lines[0]) as DecisionRecord };
}

function decodeOk(): Response {
  // `executed` is deliberately included: the seller may report one, and Mode A
  // must still record executed:false.
  return new Response(
    JSON.stringify({ intent: "ACCUMULATION", confidence: 0.8, executed: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("閾値未満の divergenceScore では Decoder を呼ばない(課金0)", async () => {
  // 既定閾値 0.75 を下回る。
  const { calls, record } = await runWithStubbedPayment(
    modeBLogWith([{ token: "ETH", divergenceScore: 0.5, smartMoneyBias: "LONG" }]),
    decodeOk
  );
  assert.equal(calls.length, 0);
  assert.equal(record.signals.whaleIntent.available, false);
  assert.equal(record.signals.whaleIntent.costUsdc, 0);
  assert.equal(record.costUsdc, 0);
});

test("閾値以上なら Decoder をちょうど1回呼ぶ(Hyperliquid 起点)", async () => {
  const { calls, record } = await runWithStubbedPayment(
    modeBLogWith([
      { token: "ETH", divergenceScore: 0.94, smartMoneyBias: "LONG" },
      { token: "SOL", divergenceScore: 0.8, smartMoneyBias: "SHORT" },
    ]),
    decodeOk
  );
  assert.equal(calls.length, 1);
  // 送るのはそのソースが実際に持っている値だけ。
  assert.deepEqual(calls[0].body, {
    token: "ETH",
    divergenceScore: 0.94,
    smartMoneyBias: "LONG",
  });
  assert.equal(record.signals.whaleIntent.available, true);
  assert.equal(record.signals.whaleIntent.intent, "ACCUMULATION");
  assert.equal(record.signals.whaleIntent.candidateSource, "hyperliquid");
  assert.equal(record.signals.whaleIntent.candidateToken, "ETH");
});

test("方向の無い候補(smartMoneyBias 欠落)はスコアが高くても発火しない", async () => {
  const { calls } = await runWithStubbedPayment(
    modeBLogWith([{ token: "ETH", divergenceScore: 0.99 }]),
    decodeOk
  );
  assert.equal(calls.length, 0);
});

test("decode が成功しても executed は false 固定", async () => {
  const { record } = await runWithStubbedPayment(
    modeBLogWith([{ token: "ETH", divergenceScore: 0.94, smartMoneyBias: "LONG" }]),
    decodeOk
  );
  assert.equal(record.executed, false);
});

test("decode 失敗時は SKIP(方向が取れないので確信度だけでは閾値に届かない)", async () => {
  const { calls, record } = await runWithStubbedPayment(
    modeBLogWith([{ token: "ETH", divergenceScore: 0.8, smartMoneyBias: "LONG" }]),
    () => new Response("upstream boom", { status: 500 })
  );
  assert.equal(calls.length, 1, "一度は呼ぶ(リトライしない)");
  assert.equal(record.signals.whaleIntent.available, false);
  assert.equal(record.signals.whaleIntent.costUsdc, 0, "失敗した呼び出しは課金として数えない");
  assert.equal(record.call.action, "SKIP");
  assert.equal(record.executed, false);
});
