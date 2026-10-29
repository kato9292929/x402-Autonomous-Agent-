/**
 * 週次 catalyst sweep(買い手・Solana)。
 *
 * 課金が絡むので「叩かなかった/払わなかった」を明示的に固定する。
 * 週次スパンドの永続化がローカルに書くため、ファイル全体を一時ディレクトリで走らせる。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-catalyst-"));
process.chdir(TMP);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

import { parseTickerList, runCatalystSweep } from "../jobs/catalyst-sweep";
import {
  isExpectedRequirement,
  observe,
  amountUnits,
  PRICE_UNITS,
  USDC_MINT,
  type CatalystClient,
} from "../catalyst/client";
import { appendCsv, CSV_HEADER, summarize, type CatalystCallRecord } from "../catalyst/record";
import type { PaymentRequirements } from "@x402/core/types";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

function req(over: Partial<Record<string, unknown>> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "solana",
    asset: USDC_MINT,
    amount: PRICE_UNITS.toString(),
    payTo: "SELLERwa11etAddress",
    maxTimeoutSeconds: 60,
    extra: {},
    ...over,
  } as unknown as PaymentRequirements;
}

/** x402 v2: challenge は PAYMENT-REQUIRED ヘッダ。本文は空でよい。 */
function challenge402(accepts: PaymentRequirements[]): Response {
  return new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: {}, accepts }) },
  });
}

// ── 安全弁: 期待する支払要件だけを払う ───────────────────────────────────────

test("isExpectedRequirement: Solana / 公式USDC mint / ちょうど PRICE_UNITS / exact のみ通す", () => {
  assert.equal(isExpectedRequirement(req()), true);
  // 金額が違えば拒否(==、上限ではない)
  assert.equal(isExpectedRequirement(req({ amount: (PRICE_UNITS + 1n).toString() })), false);
  assert.equal(isExpectedRequirement(req({ amount: (PRICE_UNITS - 1n).toString() })), false);
  // 別 mint は拒否
  assert.equal(isExpectedRequirement(req({ asset: "So11111111111111111111111111111111111111112" })), false);
  // 別チェーンは拒否(payTo=自社ではなく、これが正しい安全弁)
  assert.equal(isExpectedRequirement(req({ network: "eip155:8453" })), false);
  // exact 以外は拒否
  assert.equal(isExpectedRequirement(req({ scheme: "upto" })), false);
});

test("isExpectedRequirement: v1 の maxAmountRequired / solana:CAIP-2 も読む", () => {
  assert.equal(
    isExpectedRequirement(
      req({ amount: undefined, maxAmountRequired: PRICE_UNITS.toString(), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })
    ),
    true
  );
});

test("amountUnits: base units をそのまま読む / 読めなければ undefined", () => {
  assert.equal(amountUnits(req({ amount: "100" })), 100n);
  assert.equal(amountUnits(req({ amount: undefined, maxAmountRequired: "250" })), 250n);
  assert.equal(amountUnits(req({ amount: "x", maxAmountRequired: undefined })), undefined);
});

test("observe: 期待要件が1つでもあれば payable、Solana の額を verbatim で残す", () => {
  const o = observe({
    x402Version: 2,
    resource: {} as never,
    accepts: [req(), req({ network: "eip155:8453", asset: "0xusdc" })],
  });
  assert.equal(o.payable, true);
  assert.deepEqual(o.quotedUnits, [PRICE_UNITS.toString()]);
  assert.deepEqual(o.offeredNetworks, ["solana", "eip155:8453"]);
});

// ── ticker 一覧のパース(捏造しない) ──────────────────────────────────────────

test("parseTickerList: 文字列配列 / {tickers:[{ticker}]} の両対応", () => {
  assert.deepEqual(parseTickerList(["AAPL", "MSFT"]), ["AAPL", "MSFT"]);
  assert.deepEqual(parseTickerList({ tickers: [{ ticker: "AAPL" }, { symbol: "MSFT" }] }), ["AAPL", "MSFT"]);
  assert.deepEqual(parseTickerList({ catalysts: ["NVDA"] }), ["NVDA"]);
});

test("parseTickerList: 空・非文字列は落とす。ticker を捏造しない", () => {
  assert.deepEqual(parseTickerList({}), []);
  assert.deepEqual(parseTickerList(undefined), []);
  assert.deepEqual(parseTickerList([" ", 42, null, {}]), []);
  assert.deepEqual(parseTickerList(["AAPL", "AAPL"]), ["AAPL"]); // 重複排除
});

// ── run 0(課金ゼロ) ─────────────────────────────────────────────────────────

test("run 0: 一覧取得＋402の期待要件一致を確認し、1円も払わない", async () => {
  const seen: string[] = [];
  const report = await runCatalystSweep({
    mode: "discovery",
    fetchImpl: (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.endsWith("/api/catalyst")) return new Response(JSON.stringify(["AAPL", "MSFT", "NVDA", "TSLA"]), { status: 200 });
      return challenge402([req()]);
    }) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });
  // 一覧1回 + サンプル3件だけ(全部は叩かない)
  assert.equal(seen[0], "https://osd.x402jp.com/api/catalyst");
  assert.equal(report.records.length, 3);
  assert.ok(report.records.every((r) => r.outcome === "skipped"));
  assert.deepEqual(report.records[0].quotedUnits, [PRICE_UNITS.toString()]);
  assert.match(report.records[0].reason ?? "", /期待要件.*一致/);
  assert.equal(report.runSpentUsdc, 0);
});

test("run 0: 期待外の金額は『本番では払わない』と記録", async () => {
  const report = await runCatalystSweep({
    mode: "discovery",
    tickers: ["AAPL"],
    fetchImpl: (async () => challenge402([req({ amount: "500" })])) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].outcome, "skipped");
  assert.match(report.records[0].reason ?? "", /期待外/);
  assert.deepEqual(report.records[0].quotedUnits, ["500"]);
});

test("run 0: 到達不能は error として残る", async () => {
  const report = await runCatalystSweep({
    mode: "discovery",
    tickers: ["AAPL"],
    fetchImpl: (async () => {
      throw new Error("getaddrinfo ENOTFOUND osd.x402jp.com");
    }) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].outcome, "error");
});

// ── sweep(課金あり) ─────────────────────────────────────────────────────────

function paidResponse(body: unknown, settle: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": b64(settle) },
  });
}

function payClient(fn: (ticker: string) => Response, challenge?: () => unknown): CatalystClient {
  return {
    fetch: async (input: RequestInfo | URL) => fn(String(input).split("/").pop() ?? ""),
    takeChallenge: (challenge ?? (() => undefined)) as CatalystClient["takeChallenge"],
    walletAddress: "7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY",
  };
}

test("sweep: 200＋決済ヘッダで課金・tx を記録、実費は決済側から取る", async () => {
  const report = await runCatalystSweep({
    mode: "sweep",
    tickers: ["AAPL"],
    client: payClient(() =>
      paidResponse({ headline: "Q3 earnings beat" }, { success: true, transaction: "3Lthrqi25tx", network: "solana", amount: "1000" })
    ),
    weekSpentUsdc: 0,
    write: false,
  });
  const [r] = report.records;
  assert.equal(r.outcome, "paid");
  assert.equal(r.actualUsdc, 0.001);
  assert.equal(r.txHash, "3Lthrqi25tx");
  assert.equal(report.weekSpentUsdc, 0.001);
  assert.equal(report.summary.sampleTx, "3Lthrqi25tx");
});

test("sweep: 週上限に達していれば1件も叩かない", async () => {
  let calls = 0;
  const report = await runCatalystSweep({
    mode: "sweep",
    tickers: ["AAPL", "MSFT"],
    client: payClient(() => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }),
    weekSpentUsdc: 0.5, // 上限 0.50 に到達済み
    write: false,
  });
  assert.equal(calls, 0);
  assert.equal(report.records.length, 0);
});

test("sweep: 期待外要件で policy が弾いたら error でなく skipped(未課金)", async () => {
  const report = await runCatalystSweep({
    mode: "sweep",
    tickers: ["AAPL"],
    client: payClient(
      () => {
        throw new Error("All payment requirements were filtered out by policies");
      },
      () => ({ x402Version: 2, offeredNetworks: ["solana"], payable: false, quotedUnits: ["500"], accepts: [] })
    ),
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].outcome, "skipped");
  assert.match(report.records[0].reason ?? "", /期待外/);
  assert.equal(report.runSpentUsdc, 0);
});

test("sweep: 3回連続エラーで sweep 中断(売り手障害とみなす)", async () => {
  let calls = 0;
  const report = await runCatalystSweep({
    mode: "sweep",
    tickers: ["A", "B", "C", "D", "E"],
    client: payClient(() => {
      calls += 1;
      return new Response("down", { status: 503 });
    }),
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(calls, 3);
  assert.equal(report.records.length, 3);
});

// ── 記録 ─────────────────────────────────────────────────────────────────────

test("CSV: ヘッダは一度だけ・エスケープする", () => {
  const file = path.join(TMP, "catalyst.csv");
  const rec: CatalystCallRecord = {
    at: "2026-09-09T00:00:00Z",
    ticker: "AAPL",
    outcome: "paid",
    quotedUnits: ["100"],
    actualUsdc: 0.0001,
    latencyMs: 120,
    httpStatus: 200,
    txHash: "3Lthrqi25tx",
    summary: 'headline "beat", up',
  };
  appendCsv([rec], file);
  appendCsv([rec], file);
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('"headline ""beat"", up"'));
});

test("summarize: paid の合計と代表tx を記録から作る", () => {
  const rows: CatalystCallRecord[] = [
    { at: "", ticker: "A", outcome: "paid", latencyMs: 1, actualUsdc: 0.0001, txHash: "tx1" },
    { at: "", ticker: "B", outcome: "paid", latencyMs: 1, actualUsdc: 0.0001, txHash: "tx2" },
    { at: "", ticker: "C", outcome: "skipped", latencyMs: 1 },
    { at: "", ticker: "D", outcome: "error", latencyMs: 1 },
  ];
  const s = summarize(rows);
  assert.equal(s.paid, 2);
  assert.equal(s.totalUsdc, 0.0002);
  assert.equal(s.skipped, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.sampleTx, "tx1");
});
