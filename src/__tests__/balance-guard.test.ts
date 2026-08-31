/**
 * Balance guard: warn when a leg is low, and never present an unreadable
 * balance as a healthy one.
 *
 * The regression this protects against: the Solana payer sat at 0.000147 USDC
 * from 2026-08-18 and JIN Movers failed with "HTTP 402: {}" for a week without
 * anything saying the wallet was empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBalances, type LegBalance } from "../balance-guard";

test("残高が閾値を下回ったら警告する", () => {
  const legs: LegBalance[] = [
    { leg: "solana", address: "6JKVugbVRXR92sacDzgxBU6k6Mb9AAhxLbEy3DyWvEzA", usdc: 0.000147, threshold: 1 },
  ];
  const [w] = evaluateBalances(legs);
  assert.match(w, /LOW BALANCE/);
  assert.match(w, /solana/);
  assert.match(w, /0\.000147/);
  assert.match(w, /6JKVug…vEzA/); // どのウォレットか分かること
});

test("閾値以上なら警告しない", () => {
  const legs: LegBalance[] = [
    { leg: "solana", usdc: 2.83, threshold: 1 },
    { leg: "base", usdc: 25, threshold: 10 },
  ];
  assert.deepEqual(evaluateBalances(legs), []);
});

test("読めなかった残高は『正常』ではなく『不明』として警告する", () => {
  const legs: LegBalance[] = [{ leg: "base", usdc: undefined, threshold: 10, error: "HTTP 429" }];
  const [w] = evaluateBalances(legs);
  assert.match(w, /Could not read/);
  assert.match(w, /HTTP 429/);
  assert.doesNotMatch(w, /LOW BALANCE/); // 低残高と混同しない
});

test("アドレス未設定も不明として扱う", () => {
  const legs: LegBalance[] = [{ leg: "solana", threshold: 1, error: "no wallet address configured" }];
  const [w] = evaluateBalances(legs);
  assert.match(w, /Could not read/);
});

test("週次プローブ用ウォレットも残高ガードの対象になる", () => {
  // Base/Solana に続く3個目の枯渇候補。監視外だと同じ形で静かに止まる。
  const [w] = evaluateBalances([
    { leg: "probe", address: "0x1234567890abcdef1234567890abcdef12345678", usdc: 1.2, threshold: 5 },
  ]);
  assert.match(w, /LOW BALANCE/);
  assert.match(w, /probe/);
  assert.match(w, /0x1234…5678/);
});

test("ちょうど閾値なら警告しない、わずかに下回れば警告する", () => {
  assert.deepEqual(evaluateBalances([{ leg: "base", usdc: 10, threshold: 10 }]), []);
  assert.equal(evaluateBalances([{ leg: "base", usdc: 9.999999, threshold: 10 }]).length, 1);
});

test("両レグが低ければ両方報告する", () => {
  const warnings = evaluateBalances([
    { leg: "base", usdc: 0.5, threshold: 10 },
    { leg: "solana", usdc: 0, threshold: 1 },
  ]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("base")));
  assert.ok(warnings.some((w) => w.includes("solana")));
});
