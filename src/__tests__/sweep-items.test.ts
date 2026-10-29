/**
 * Per-company sweep settlements: durable store + paging. The point is that all
 * ~200 rows are retrievable, not just a summary.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-sweepitems-"));
process.chdir(TMP);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

import { saveSweepItems, loadSweepItems, type SweepItem } from "../store/sweep-items";

function make(n: number): SweepItem[] {
  return Array.from({ length: n }, (_, i) => ({
    ticker: `E${1000 + i}`,
    amountUsdc: 0.001,
    tx: `tx${i}`,
    at: "2026-09-10T00:06:00Z",
  }));
}

test("197件を保存し、全件がページングで取り出せる", async () => {
  await saveSweepItems("edinet", "2026-W37", make(197));

  const p1 = await loadSweepItems("edinet", "2026-W37", 0, 50);
  assert.equal(p1.total, 197);
  assert.equal(p1.items.length, 50);
  assert.equal(p1.items[0].ticker, "E1000");

  const p2 = await loadSweepItems("edinet", "2026-W37", 50, 50);
  assert.equal(p2.items[0].ticker, "E1050");

  // 全ページを集めると 197 件・欠けなし。
  let all: SweepItem[] = [];
  for (let off = 0; off < 197; off += 50) {
    all = all.concat((await loadSweepItems("edinet", "2026-W37", off, 50)).items);
  }
  assert.equal(all.length, 197);
  assert.equal(new Set(all.map((i) => i.tx)).size, 197);
});

test("再実行は週の集合を上書きする(追記しない)", async () => {
  await saveSweepItems("catalyst", "2026-W40", make(10));
  await saveSweepItems("catalyst", "2026-W40", make(3));
  assert.equal((await loadSweepItems("catalyst", "2026-W40", 0, 50)).total, 3);
});

test("surface/week が別なら混ざらない", async () => {
  await saveSweepItems("edinet", "2026-W38", make(5));
  await saveSweepItems("catalyst", "2026-W38", make(9));
  assert.equal((await loadSweepItems("edinet", "2026-W38", 0, 50)).total, 5);
  assert.equal((await loadSweepItems("catalyst", "2026-W38", 0, 50)).total, 9);
});

test("未知の surface/week は空(捏造しない)", async () => {
  const p = await loadSweepItems("edinet", "2099-W01", 0, 50);
  assert.equal(p.total, 0);
  assert.deepEqual(p.items, []);
});

test("tx のみの行(ticker 無し)も保持できる(バックフィルのオンチェーン分)", async () => {
  await saveSweepItems("edinet", "2026-W41", [{ ticker: "", amountUsdc: 0.001, tx: "onchain1", at: "x" }]);
  const p = await loadSweepItems("edinet", "2026-W41", 0, 50);
  assert.equal(p.items[0].ticker, "");
  assert.equal(p.items[0].tx, "onchain1");
});
