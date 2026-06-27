/**
 * summarizeYield: 実レスポンス由来の値を読み、無いフィールドは「なし」と
 * 明記する(0 や実値と誤認させない)ことを検証する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeYield } from "../modes/yield-observe";

test("実データ(stats + topPools + liveSources)を読み出す", () => {
  const line = summarizeYield({
    stats: { apyResolved: 7, apyTotal: 12 },
    liveSources: ["Kamino", "Nansen"],
    topPools: [
      { protocol: "Kamino", pair: "USDC-SOL", apySource: "live", smartMoneyInflow7d: 5123456 },
      { protocol: "Drift", pair: "SOL-PERP", apySource: "static", smartMoneyInflow7d: 100 },
    ],
  });
  assert.match(line, /apyResolved=7\/12/);
  assert.match(line, /liveSources=\[Kamino, Nansen\]/);
  assert.match(line, /Kamino-USDC-SOL=5123456/);
  // stats に live/static が無いので topPools から集計
  assert.match(line, /live=1 static=1/);
});

test("フィールドが無い場合は「なし(未存在)」と出す(0で埋めない)", () => {
  const line = summarizeYield({ foo: "bar" });
  assert.match(line, /apyResolved=なし\(フィールド未存在\)/);
  assert.match(line, /liveSources=なし\(フィールド未存在\)/);
  assert.match(line, /smartMoney例 なし\(topPools未存在\)/);
  assert.doesNotMatch(line, /apyResolved=0/);
});

test("レスポンス本体が無いとき(fullData未取得)を明示", () => {
  assert.match(summarizeYield(undefined), /レスポンス本体なし\(fullData未取得\)/);
});

test("Kamino USDC-SOL が無ければ先頭プールをサンプルにしラベル付き", () => {
  const line = summarizeYield({
    topPools: [{ protocol: "Drift", pair: "SOL-USDC", smartMoneyInflow7d: 42 }],
  });
  assert.match(line, /smartMoney例 Drift-SOL-USDC=42/);
});

test("smartMoneyInflow7d が無い代表プールは『なし』と出す", () => {
  const line = summarizeYield({
    topPools: [{ protocol: "Kamino", pair: "USDC-SOL", apySource: "live" }],
  });
  assert.match(line, /Kamino-USDC-SOL smartMoneyInflow7d なし\(フィールド未存在\)/);
});
