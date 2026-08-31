/**
 * 週次 外部 x402 プローブ: 予算の天井、run 0 の無課金、読み取り専用の固定、記録。
 *
 * 課金が絡むので「叩かなかったこと」を明示的に固定する。
 * 週次スパンドの永続化がローカルに書くため、ファイル全体を一時ディレクトリで走らせる。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-probe-"));
process.chdir(TMP);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

import {
  PROBE_TARGETS,
  isExecutionPath,
  plannedCallCount,
  type ProbeTarget,
} from "../probe/targets";
import { allowsCall, isoWeekKey, perCallMicroUsdc } from "../probe/budget";
import { observe } from "../probe/client";
import { appendCsv, CSV_HEADER, summarize, toCsvRow, type ProbeCallRecord } from "../probe/record";
import { runExternalProbe } from "../jobs/external-probe";
import type { ProbeClient } from "../probe/client";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

/** x402 v2: challenge は PAYMENT-REQUIRED ヘッダに乗る(本文は空でよい)。 */
function challenge402(accepts: Array<Record<string, unknown>>): Response {
  return new Response("{}", {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: {}, accepts }),
    },
  });
}

/** x402 v1: challenge は本文に乗り、金額は maxAmountRequired。 */
function challenge402v1(accepts: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ x402Version: 1, accepts }), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  });
}

function baseRequirement(amountMicro: string): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: amountMicro,
    payTo: "0xseller",
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function target(over: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    id: "t",
    name: "T",
    host: "https://seller.example",
    listedChains: ["base"],
    weeklyCallBudget: 10,
    metadata: [],
    probes: [{ path: "/data", method: "GET" }],
    question: "",
    ...over,
  };
}

// ── 読み取り専用 ─────────────────────────────────────────────────────────────

test("実行系ルートは対象リストに一件も無い(Otto AI の /swap /trade-perpetuals 含む)", () => {
  for (const t of PROBE_TARGETS) {
    for (const p of t.probes) {
      assert.equal(isExecutionPath(p.path), false, `${t.id}${p.path}`);
    }
    for (const m of t.metadata) {
      assert.equal(isExecutionPath(m), false, `${t.id}${m}`);
    }
  }
  assert.equal(isExecutionPath("/swap"), true);
  assert.equal(isExecutionPath("/trade-perpetuals"), true);
});

test("実行系ルートが混ざっても sweep は呼び出し0で記録だけ残す", async () => {
  let calls = 0;
  const client: ProbeClient = {
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    takeChallenge: () => undefined,
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [target({ probes: [{ path: "/swap", method: "POST" }] })],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(calls, 0, "執行系は一度も叩かない");
  assert.equal(report.records[0].outcome, "skipped");
  assert.match(report.records[0].reason ?? "", /執行系/);
  assert.equal(report.runSpentUsdc, 0);
});

// ── 予算 ─────────────────────────────────────────────────────────────────────

test("1コール上限 $0.20 を超える見積りは拒否される", () => {
  assert.equal(allowsCall(0.2, 0, 0).allowed, true, "ちょうどは通す");
  const over = allowsCall(0.25, 0, 0);
  assert.equal(over.allowed, false);
  assert.equal(over.ceiling, "per_call");
});

test("1回上限 $2.00 / 週上限 $4.00 が別々に効く", () => {
  const run = allowsCall(0.1, 1.95, 0);
  assert.equal(run.allowed, false);
  assert.equal(run.ceiling, "per_run");

  const week = allowsCall(0.1, 0, 3.95);
  assert.equal(week.allowed, false);
  assert.equal(week.ceiling, "per_week");

  // 週上限は1回上限の2倍。2回目の run が丸ごと弾かれない。
  assert.equal(allowsCall(0.1, 0, 2.0).allowed, true);
});

test("読めない/不正な見積りは通さない", () => {
  assert.equal(allowsCall(Number.NaN, 0, 0).allowed, false);
  assert.equal(allowsCall(-1, 0, 0).allowed, false);
});

test("perCallMicroUsdc: policy に渡す micro-USDC 上限", () => {
  assert.equal(perCallMicroUsdc(0.2), 200000n);
});

test("isoWeekKey: 月曜始まりの ISO 週", () => {
  assert.equal(isoWeekKey(new Date("2026-08-31T00:00:00Z")), "2026-W36"); // 月曜
  assert.equal(isoWeekKey(new Date("2026-09-06T23:59:00Z")), "2026-W36"); // 同週の日曜
  assert.equal(isoWeekKey(new Date("2026-09-07T00:00:00Z")), "2026-W37"); // 翌月曜
});

// ── 402 の読み取り(公式パーサ経由) ───────────────────────────────────────────

test("observe: 支払えるチェーンの最安値だけを見積りにする", () => {
  const o = observe({
    x402Version: 2,
    resource: {} as never,
    accepts: [
      baseRequirement("50000") as never, // $0.05 Base
      { ...baseRequirement("10000"), network: "solana:mainnet" } as never, // 払えない
    ],
  });
  assert.equal(o.quotedUsdc, 0.05);
  assert.deepEqual(o.offeredNetworks, ["eip155:8453", "solana:mainnet"]);
});

test("observe: 対応チェーンが無ければ見積りは undefined(掲載価格で埋めない)", () => {
  const o = observe({
    x402Version: 2,
    resource: {} as never,
    accepts: [{ ...baseRequirement("10000"), network: "solana:mainnet" } as never],
  });
  assert.equal(o.quotedUsdc, undefined);
});

// ── run 0(課金ゼロ) ─────────────────────────────────────────────────────────

test("run 0: v2 ヘッダの 402 から単価を読み、1円も払わない", async () => {
  const seen: string[] = [];
  const report = await runExternalProbe({
    mode: "discovery",
    targets: [target({ metadata: ["/.well-known/x402"] })],
    fetchImpl: (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.endsWith("/.well-known/x402")) {
        return new Response(JSON.stringify({ routes: 3 }), { status: 200 });
      }
      return challenge402([baseRequirement("4000")]); // $0.004
    }) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });

  assert.deepEqual(seen, [
    "https://seller.example/.well-known/x402",
    "https://seller.example/data",
  ]);
  const [meta, paid] = report.records;
  assert.equal(meta.outcome, "free");
  assert.equal(paid.outcome, "skipped");
  assert.equal(paid.quotedUsdc, 0.004);
  assert.equal(paid.actualUsdc, undefined);
  assert.equal(report.runSpentUsdc, 0);
});

test("run 0: v1 は本文の maxAmountRequired から読む", async () => {
  const report = await runExternalProbe({
    mode: "discovery",
    targets: [target()],
    fetchImpl: (async () =>
      challenge402v1([
        { scheme: "exact", network: "base", maxAmountRequired: "2500", payTo: "0x" },
      ])) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].quotedUsdc, 0.0025);
});

test("run 0: 上限超えの単価は『本番でも叩かない』として記録される", async () => {
  const report = await runExternalProbe({
    mode: "discovery",
    targets: [target()],
    fetchImpl: (async () => challenge402([baseRequirement("500000")])) as typeof globalThis.fetch, // $0.50
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].quotedUsdc, 0.5);
  assert.equal(report.records[0].outcome, "skipped");
  assert.match(report.records[0].reason ?? "", /上限超過/);
});

test("run 0: 到達不能は error として残り、他の先を止めない", async () => {
  const report = await runExternalProbe({
    mode: "discovery",
    targets: [target({ id: "a" }), target({ id: "b" })],
    fetchImpl: (async (input: RequestInfo | URL) => {
      throw new Error(`getaddrinfo ENOTFOUND ${String(input)}`);
    }) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records.length, 2);
  assert.equal(report.records[0].outcome, "error");
  assert.equal(report.records[1].target, "b");
});

// ── sweep(課金あり) ─────────────────────────────────────────────────────────

/** 決済ヘッダ付きの成功レスポンス。 */
function paidResponse(body: unknown, settle: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": b64(settle) },
  });
}

test("sweep: 実課金額は決済レスポンスから取る(掲載価格を写さない)", async () => {
  const client: ProbeClient = {
    fetch: async () =>
      paidResponse(
        { blockNumber: 12345678 },
        { success: true, transaction: "0xtx", network: "eip155:8453", amount: "6000" }
      ),
    // 見積りは $0.004、実際に引かれたのは $0.006。
    takeChallenge: () => ({
      x402Version: 2,
      offeredNetworks: ["eip155:8453"],
      quotedUsdc: 0.004,
      accepts: [baseRequirement("4000") as never],
    }),
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [target()],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  const [r] = report.records;
  assert.equal(r.outcome, "paid");
  assert.equal(r.quotedUsdc, 0.004);
  assert.equal(r.actualUsdc, 0.006);
  assert.equal(r.chain, "eip155:8453");
  assert.equal(r.txHash, "0xtx");
  assert.equal(r.summary, "blockNumber 12345678");
  assert.equal(report.runSpentUsdc, 0.006);
  assert.equal(report.weekSpentUsdc, 0.006);
});

test("sweep: 1回上限に達したらそこで打ち切る", async () => {
  let calls = 0;
  const client: ProbeClient = {
    fetch: async () => {
      calls += 1;
      return paidResponse(
        { ok: 1 },
        { success: true, transaction: "0xtx", network: "eip155:8453", amount: "1500000" } // $1.50
      );
    },
    takeChallenge: () => ({
      x402Version: 2,
      offeredNetworks: ["eip155:8453"],
      quotedUsdc: 1.5,
      accepts: [baseRequirement("1500000") as never],
    }),
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [
      target({
        probes: [
          { path: "/a", method: "GET" },
          { path: "/b", method: "GET" },
          { path: "/c", method: "GET" },
        ],
      }),
    ],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  // $1.50 × 2 = $3.00 で 1回上限 $2.00 を超えるため 3本目は叩かない。
  assert.equal(calls, 2);
  assert.equal(report.records.length, 2);
});

test("sweep: 週上限に達していれば1本も叩かない", async () => {
  let calls = 0;
  const client: ProbeClient = {
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    takeChallenge: () => undefined,
    walletAddress: "0xprobe",
  };
  await runExternalProbe({
    mode: "sweep",
    targets: [target()],
    client,
    weekSpentUsdc: 4.0,
    write: false,
  });
  assert.equal(calls, 0);
});

test("sweep: policy が要件を全部落とした場合は error でなく skipped(未課金)", async () => {
  const client: ProbeClient = {
    fetch: async () => {
      throw new Error("All payment requirements were filtered out by policies");
    },
    takeChallenge: () => ({
      x402Version: 2,
      offeredNetworks: ["eip155:8453"],
      quotedUsdc: 0.5, // 上限超過
      accepts: [baseRequirement("500000") as never],
    }),
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [target()],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].outcome, "skipped");
  assert.equal(report.records[0].quotedUsdc, 0.5);
  assert.match(report.records[0].reason ?? "", /予算で拒否\(per_call\)/);
  assert.equal(report.runSpentUsdc, 0);
});

test("sweep: 支払えるチェーンが無い先は skipped として残す", async () => {
  const client: ProbeClient = {
    fetch: async () => {
      throw new Error("no scheme registered");
    },
    takeChallenge: () => ({
      x402Version: 2,
      offeredNetworks: ["solana:mainnet"],
      quotedUsdc: undefined,
      accepts: [],
    }),
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [target()],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(report.records[0].outcome, "skipped");
  assert.match(report.records[0].reason ?? "", /対応しないチェーン/);
});

test("sweep: 同一先で3回連続エラーならその先を当日スキップ", async () => {
  let calls = 0;
  const client: ProbeClient = {
    fetch: async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    },
    takeChallenge: () => undefined,
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [
      target({
        probes: [
          { path: "/a", method: "GET" },
          { path: "/b", method: "GET" },
          { path: "/c", method: "GET" },
          { path: "/d", method: "GET" },
          { path: "/e", method: "GET" },
        ],
      }),
    ],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(calls, 3);
  assert.equal(report.records.length, 3);
});

test("sweep: 有料ルート未確定の先は run0 待ちとして叩かない", async () => {
  let calls = 0;
  const client: ProbeClient = {
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    takeChallenge: () => undefined,
    walletAddress: "0xprobe",
  };
  const report = await runExternalProbe({
    mode: "sweep",
    targets: [target({ probes: [] })],
    client,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(calls, 0);
  assert.equal(report.records.length, 0);
});

// ── 記録 ─────────────────────────────────────────────────────────────────────

test("CSV: ヘッダは一度だけ、カンマ・引用符はエスケープされる", () => {
  const file = path.join(TMP, "probe.csv");
  const rec: ProbeCallRecord = {
    at: "2026-08-31T00:00:00Z",
    target: "otto",
    path: "/token-details",
    method: "GET",
    latencyMs: 120,
    httpStatus: 200,
    outcome: "paid",
    quotedUsdc: 0.001,
    actualUsdc: 0.001,
    chain: "eip155:8453",
    summary: 'apy 0.213 | note "x", y',
  };
  appendCsv([rec], file);
  appendCsv([rec], file);
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('"apy 0.213 | note ""x"", y"'), lines[1]);
  assert.ok(lines[1].endsWith(","), "quality 列は人が埋めるので空のまま");
});

test("summarize: 実測 per-call と成功率は記録から計算する", () => {
  const rows: ProbeCallRecord[] = [
    { at: "", target: "a", path: "/1", method: "GET", latencyMs: 1, outcome: "paid", actualUsdc: 0.01 },
    { at: "", target: "a", path: "/2", method: "GET", latencyMs: 1, outcome: "paid", actualUsdc: 0.03 },
    { at: "", target: "a", path: "/3", method: "GET", latencyMs: 1, outcome: "error" },
    { at: "", target: "a", path: "/4", method: "GET", latencyMs: 1, outcome: "skipped" },
  ];
  const [s] = summarize(rows);
  assert.equal(s.paidCalls, 2);
  assert.equal(s.totalUsdc, 0.04);
  assert.equal(s.measuredPerCallUsdc, 0.02);
  // skipped は「叩いていない」ので分母に入れない: 3本中2本成功。
  assert.equal(Math.round(s.successRate * 100), 67);
});

test("toCsvRow: 未確定の値は空欄。0 で埋めない", () => {
  const row = toCsvRow({
    at: "2026-08-31T00:00:00Z",
    target: "gocreative",
    path: "/x",
    method: "GET",
    latencyMs: 5,
    outcome: "skipped",
    reason: "単価未確認",
  });
  const cells = row.split(",");
  assert.equal(cells[5], "", "quoted_usdc は空");
  assert.equal(cells[6], "", "actual_usdc は空");
});

test("plannedCallCount: 有料ルートが確定していない先は 0 本として数える", () => {
  assert.equal(plannedCallCount([target({ probes: [] })]), 0);
  assert.equal(plannedCallCount(PROBE_TARGETS), 3); // 現時点で確定しているのは Otto AI の3本
});
