/**
 * Fallback cooldown: pure decide/next logic. N=3 degraded days → cooldown,
 * skip daily buys, probe every P days, live clears it. 冪等(同日再実行で二重加算しない)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideCall,
  nextState,
  initialState,
  FALLBACK_DAYS,
  PROBE_INTERVAL_DAYS,
  type CooldownState,
} from "../modes/fallback-cooldown";

// 既定で回す前提を固定(env 未設定時)。
assert.equal(FALLBACK_DAYS, 3);
assert.equal(PROBE_INTERVAL_DAYS, 3);

/** Feed a sequence of daily outcomes and return the final state. */
function drive(days: Array<{ date: string; outcome: "live" | "fallback" | "error" }>): CooldownState {
  let s = initialState("apac-macro-dashboard");
  for (const d of days) {
    const plan = decideCall(s, d.date);
    if (!plan.call) continue; // skipped day (cooldown, not a probe day)
    s = nextState(s, d.date, d.outcome, plan.probe);
  }
  return s;
}

test("3日連続 fallback で cooldown に入る", () => {
  const s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "fallback" },
    { date: "2026-09-03", outcome: "fallback" },
  ]);
  assert.equal(s.consecutiveFallback, 3);
  assert.equal(s.inCooldown, true);
  assert.equal(s.since, "2026-09-03");
});

test("2日では cooldown に入らない(N=3 未満)", () => {
  const s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "fallback" },
  ]);
  assert.equal(s.inCooldown, false);
  assert.equal(decideCall(s, "2026-09-03").call, true, "まだ毎日叩く");
});

test("途中で live が入れば連続カウントがリセットされる", () => {
  const s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "live" },
    { date: "2026-09-03", outcome: "fallback" },
  ]);
  assert.equal(s.consecutiveFallback, 1);
  assert.equal(s.inCooldown, false);
});

test("cooldown 中は毎日は叩かない(購入停止で $ 節約)", () => {
  const s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "fallback" },
    { date: "2026-09-03", outcome: "fallback" }, // cooldown 突入、lastProbeDate=2026-09-03
  ]);
  assert.equal(decideCall(s, "2026-09-04").call, false, "翌日は叩かない");
  assert.equal(decideCall(s, "2026-09-05").call, false);
});

test("cooldown 中も P 日ごとにプローブする", () => {
  let s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "fallback" },
    { date: "2026-09-03", outcome: "fallback" },
  ]);
  // since=09-03。3日後 = 09-06 がプローブ日。
  const plan = decideCall(s, "2026-09-06");
  assert.equal(plan.call, true);
  assert.equal(plan.probe, true);
});

test("プローブで live が返れば cooldown 解除 → 毎日購入に復帰", () => {
  let s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "fallback" },
    { date: "2026-09-03", outcome: "fallback" },
  ]);
  const plan = decideCall(s, "2026-09-06"); // probe day
  assert.equal(plan.probe, true);
  s = nextState(s, "2026-09-06", "live", plan.probe);
  assert.equal(s.inCooldown, false);
  assert.equal(s.consecutiveFallback, 0);
  assert.equal(decideCall(s, "2026-09-07").call, true, "翌日から通常購入");
});

test("プローブでまだ fallback なら cooldown 継続、次のプローブは P 日後", () => {
  let s = drive([
    { date: "2026-09-01", outcome: "fallback" },
    { date: "2026-09-02", outcome: "fallback" },
    { date: "2026-09-03", outcome: "fallback" },
  ]);
  const p1 = decideCall(s, "2026-09-06");
  s = nextState(s, "2026-09-06", "fallback", p1.probe);
  assert.equal(s.inCooldown, true);
  assert.equal(s.lastProbeDate, "2026-09-06");
  assert.equal(decideCall(s, "2026-09-07").call, false, "翌日は叩かない");
  assert.equal(decideCall(s, "2026-09-09").probe, true, "P日後に再プローブ");
});

test("同じ日に2回叩いても連続カウントは二重加算しない", () => {
  let s = initialState("x");
  s = nextState(s, "2026-09-01", "fallback", false);
  s = nextState(s, "2026-09-01", "fallback", false); // same day rerun
  assert.equal(s.consecutiveFallback, 1);
});

test("error は fallback と別: 連続カウントを進めない", () => {
  let s = initialState("x");
  s = nextState(s, "2026-09-01", "fallback", false);
  s = nextState(s, "2026-09-02", "error", false);
  assert.equal(s.consecutiveFallback, 1, "error では増えない");
  assert.equal(s.inCooldown, false);
});
