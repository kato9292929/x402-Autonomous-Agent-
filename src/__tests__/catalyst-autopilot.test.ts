/**
 * Catalyst autopilot の状態機械。安全性は冪等性がすべて(Railway は push 毎に再デプロイ)なので、
 * 「二度払わない」「未確認なら止まる」を明示的に固定する。依存は注入する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runCatalystAutopilot,
  readAutopilotState,
  resetAutopilotState,
  writeAutopilotState,
  type AutopilotState,
  type AutopilotDeps,
} from "../jobs/catalyst-autopilot";
import type { CatalystRunReport } from "../jobs/catalyst-sweep";
import type { CatalystCallRecord } from "../catalyst/record";

function report(records: CatalystCallRecord[]): CatalystRunReport {
  return {
    mode: "sweep",
    week: "2026-W37",
    tickers: records.map((r) => r.ticker),
    records,
    summary: { tickers: records.length, paid: 0, free: 0, skipped: 0, errors: 0, totalUsdc: 0 },
    runSpentUsdc: 0,
    weekSpentUsdc: 0,
  };
}

function rec(over: Partial<CatalystCallRecord>): CatalystCallRecord {
  return { at: "", ticker: "AAPL", outcome: "skipped", latencyMs: 1, ...over };
}

interface Overrides {
  initial?: AutopilotState;
  durable?: boolean;
  /** What run0 returns; default = one payable ticker. */
  discovery?: () => CatalystRunReport;
  /** What the smoke returns; default = a settled payment with a tx. */
  smoke?: (tickers: string[]) => CatalystRunReport;
}

/**
 * Deps with in-memory state. Counting always wraps the (possibly overridden)
 * impl, so an override cannot accidentally drop a call count.
 */
function makeDeps(over: Overrides = {}): {
  deps: AutopilotDeps;
  calls: { discovery: number; smoke: number; onLive: number; writes: AutopilotState[] };
  state: () => AutopilotState;
} {
  let state: AutopilotState = over.initial ?? { stage: "unstarted" };
  const calls = { discovery: 0, smoke: 0, onLive: 0, writes: [] as AutopilotState[] };
  const discovery = over.discovery ?? (() => report([rec({ ticker: "AAPL", payable: true, quotedUnits: ["100"] })]));
  const smoke =
    over.smoke ??
    ((tickers: string[]) =>
      report([
        rec({ ticker: tickers[0], outcome: "paid", txHash: "3Lthrqi25tx", actualUsdc: 0.0001, summary: "headline X" }),
      ]));

  const deps: AutopilotDeps = {
    durable: over.durable ?? true,
    readState: async () => state,
    writeState: async (s) => {
      state = s;
      calls.writes.push(s);
    },
    runDiscovery: async () => {
      calls.discovery += 1;
      return discovery();
    },
    runSmoke: async (tickers) => {
      calls.smoke += 1;
      return smoke(tickers);
    },
    onLive: () => {
      calls.onLive += 1;
    },
  };
  return { deps, calls, state: () => state };
}

test("unstarted: run0 で払える402→1件だけ smoke→live に遷移して onLive", async () => {
  const { deps, calls, state } = makeDeps();
  const result = await runCatalystAutopilot(deps);
  assert.equal(calls.discovery, 1);
  assert.equal(calls.smoke, 1);
  assert.equal(result.stage, "live");
  assert.equal(result.smokeTx, "3Lthrqi25tx");
  assert.equal(calls.onLive, 1);
  // 払う前に smoking を書き、確認後に live を書く(順序が冪等性の要)
  assert.deepEqual(calls.writes.map((w) => w.stage), ["smoking", "live"]);
  assert.equal(state().stage, "live");
});

test("live: 二度と払わない。onLive だけ呼んでスケジュールする", async () => {
  const { deps, calls } = makeDeps({ initial: { stage: "live", ticker: "AAPL", smokeTx: "tx" } });
  await runCatalystAutopilot(deps);
  assert.equal(calls.discovery, 0);
  assert.equal(calls.smoke, 0, "既に live なら smoke を再実行しない=再課金しない");
  assert.equal(calls.onLive, 1);
});

test("smoking: 前回未確認なら止まる。払わない・スケジュールしない", async () => {
  const { deps, calls } = makeDeps({ initial: { stage: "smoking", ticker: "AAPL" } });
  const result = await runCatalystAutopilot(deps);
  assert.equal(calls.smoke, 0, "crash ループでも毎ブート課金しない");
  assert.equal(calls.onLive, 0);
  assert.equal(result.stage, "smoking");
});

test("run0 に払える402が無ければ smoke しない(未払い・retry 余地を残す)", async () => {
  const { deps, calls } = makeDeps({
    discovery: () => report([rec({ ticker: "AAPL", payable: false, reason: "期待外" })]),
  });
  const result = await runCatalystAutopilot(deps);
  assert.equal(calls.smoke, 0);
  assert.equal(calls.onLive, 0);
  assert.equal(result.stage, "unstarted", "状態を進めない=次ブートで再挑戦");
});

test("durable store が無ければ有料 smoke を拒否(再デプロイ再課金を防ぐ)", async () => {
  const { deps, calls } = makeDeps({ durable: false });
  const result = await runCatalystAutopilot(deps);
  assert.equal(calls.discovery, 1);
  assert.equal(calls.smoke, 0);
  assert.equal(result.stage, "unstarted");
});

test("smoke が error(曖昧/決済したかも)なら smoking のまま halt", async () => {
  const { deps, calls } = makeDeps({
    smoke: () => report([rec({ ticker: "AAPL", outcome: "error", reason: "HTTP 500" })]),
  });
  const result = await runCatalystAutopilot(deps);
  assert.equal(calls.smoke, 1);
  assert.equal(calls.onLive, 0);
  assert.equal(result.stage, "smoking", "資金移動したかもしれない時だけ人が見る");
});

test("smoke が skipped(クリーンな402・資金未移動)なら unstarted に自動ロールバック", async () => {
  const { deps, calls, state } = makeDeps({
    smoke: () => report([rec({ ticker: "AAPL", outcome: "skipped", reason: "期待外の支払要件" })]),
  });
  const result = await runCatalystAutopilot(deps);
  assert.equal(calls.smoke, 1);
  assert.equal(calls.onLive, 0);
  assert.equal(result.stage, "unstarted", "署名前に弾かれた=資金未移動→次ブートで再挑戦");
  // smoking を書いた後、unstarted に戻す
  assert.deepEqual(calls.writes.map((w) => w.stage), ["smoking", "unstarted"]);
  assert.equal(state().stage, "unstarted");
});

test("smoke が free(402なし・未課金)でも unstarted に自動ロールバック", async () => {
  const { deps, state } = makeDeps({
    smoke: () => report([rec({ ticker: "AAPL", outcome: "free", reason: "無課金で200" })]),
  });
  const result = await runCatalystAutopilot(deps);
  assert.equal(result.stage, "unstarted");
  assert.equal(state().stage, "unstarted");
});

test("resetAutopilotState: stuck な smoking を unstarted に戻す(1コマンド相当)", async () => {
  // 永続層(ローカルフォールバック)へ実際に書くので一時ディレクトリで走らせる。
  const original = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-catreset-"));
  process.chdir(tmp);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    await writeAutopilotState({ stage: "smoking", ticker: "AAPL" });
    const before = await resetAutopilotState();
    assert.equal(before.stage, "smoking", "戻す前の状態を返す");
    assert.equal((await readAutopilotState()).stage, "unstarted");
  } finally {
    process.chdir(original);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
