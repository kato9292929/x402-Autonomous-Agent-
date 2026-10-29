/**
 * Mode A の純粋ロジック: シグナル抽出とスコアリング。
 * node:test (Node.js 20+).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDivergenceSignal,
  extractSmartMoneyRows,
  selectSmartMoneyCandidate,
  scoreScaleOf,
  describeRows,
  type SmartMoneyRow,
  type SmartMoneyThresholds,
} from "../modes/signal-extract";
import { scoreSmartMoney } from "../modes/scoring";

const OPEN: SmartMoneyThresholds = { minScore: 0, minNetFlowUsd: 0, minSmWallets: 0 };

// ── Divergence Analyzer(Mode B に残っているだけ。Mode A の候補源ではない) ──────

test("extractDivergenceSignal reads nansenNetFlowUsd from a nested array", () => {
  const data = {
    divergences: [
      { token: "ETH", chain: "ethereum", nansenNetFlowUsd: 4_200_000 },
      { token: "BTC", chain: "bitcoin", nansenNetFlowUsd: -1_000_000 },
    ],
  };
  const sig = extractDivergenceSignal(data);
  assert.equal(sig.available, true);
  assert.equal(sig.token, "ETH"); // largest |netFlow|
  assert.equal(sig.netFlowUsd, 4_200_000);
});

test("extractDivergenceSignal tolerates field-name variants", () => {
  const sig = extractDivergenceSignal({ result: { symbol: "SOL", netFlowUsd: "250000" } });
  assert.equal(sig.available, true);
  assert.equal(sig.token, "SOL");
  assert.equal(sig.netFlowUsd, 250000);
});

test("extractDivergenceSignal returns unavailable when no net-flow present", () => {
  assert.equal(extractDivergenceSignal({ tokens: [], total_scanned: 0 }).available, false);
  assert.equal(extractDivergenceSignal(undefined).available, false);
  assert.equal(extractDivergenceSignal(null).available, false);
});

// ── Smart Money Screener の行 ────────────────────────────────────────────────

// 掲載カラム: RANK / TOKEN / CHAIN / SM WALLETS / NET FLOW(24h) / SCORE
const screener = {
  total_scanned: 3,
  tokens: [
    { rank: 1, token: "AERO", chain: "base", smWallets: 14, netFlow24h: 5_200_000, score: 82 },
    { rank: 2, token: "DEGEN", chain: "base", smWallets: 9, netFlow24h: -1_100_000, score: 61 },
    { rank: 3, token: "BRETT", chain: "base", smWallets: 4, netFlow24h: 300_000, score: 44 },
  ],
};

test("extractSmartMoneyRows: 掲載カラムをそのまま読む", () => {
  const rows = extractSmartMoneyRows(screener);
  assert.equal(rows.length, 3);
  const expected: SmartMoneyRow = {
    rank: 1,
    token: "AERO",
    chain: "base",
    smWallets: 14,
    netFlowUsd: 5_200_000,
    score: 82,
  };
  assert.deepEqual(rows[0], expected);
});

test("extractSmartMoneyRows: snake_case / 別名フィールドにも耐える", () => {
  const rows = extractSmartMoneyRows({
    results: [{ symbol: "AERO", network: "base", smart_money_wallets: 12, net_flow_24h: "900000", sm_score: 0.7 }],
  });
  assert.equal(rows[0].token, "AERO");
  assert.equal(rows[0].chain, "base");
  assert.equal(rows[0].smWallets, 12);
  assert.equal(rows[0].netFlowUsd, 900000);
  assert.equal(rows[0].score, 0.7);
});

test("extractSmartMoneyRows: 空・判断フィールド無しの行は作らない(捏造しない)", () => {
  assert.deepEqual(extractSmartMoneyRows({ tokens: [], total_scanned: 0 }), []);
  assert.deepEqual(extractSmartMoneyRows(undefined), []);
  // token だけで数字が無い行はスクリーナー行ではない
  assert.deepEqual(extractSmartMoneyRows({ tokens: [{ token: "AERO" }] }), []);
});

test("scoreScaleOf: score の桁を固定のはしご(1/10/100)で決める", () => {
  assert.equal(scoreScaleOf([{ token: "a", score: 0.7 }]), 1);
  assert.equal(scoreScaleOf([{ token: "a", score: 8 }]), 10);
  assert.equal(scoreScaleOf([{ token: "a", score: 82 }]), 100);
  assert.equal(scoreScaleOf([{ token: "a" }]), undefined);
  // その日の最大値を尺度にしない(同じ 82 が日によって違う意味になるため)
  assert.equal(scoreScaleOf([{ token: "a", score: 82 }, { token: "b", score: 44 }]), 100);
});

test("selectSmartMoneyCandidate: score 最大の行を採り、方向は net flow の符号から取る", () => {
  const c = selectSmartMoneyCandidate(extractSmartMoneyRows(screener), OPEN);
  assert.equal(c?.token, "AERO");
  assert.equal(c?.direction, 1);
  assert.equal(c?.normalizedScore, 0.82);
  assert.equal(c?.scoreScale, 100);
});

test("selectSmartMoneyCandidate: 流出は short 方向", () => {
  const c = selectSmartMoneyCandidate(
    extractSmartMoneyRows({ tokens: [screener.tokens[1]] }),
    OPEN
  );
  assert.equal(c?.direction, -1);
});

test("selectSmartMoneyCandidate: 3つの閾値それぞれで落ちる", () => {
  const rows = extractSmartMoneyRows(screener);
  assert.equal(selectSmartMoneyCandidate(rows, { ...OPEN, minScore: 90 }), undefined);
  assert.equal(selectSmartMoneyCandidate(rows, { ...OPEN, minNetFlowUsd: 9_000_000 }), undefined);
  assert.equal(selectSmartMoneyCandidate(rows, { ...OPEN, minSmWallets: 20 }), undefined);
  // 閾値が緩めば通る(規模は絶対値で見る: 流出も候補になる)
  assert.equal(
    selectSmartMoneyCandidate(rows, { ...OPEN, minNetFlowUsd: 1_000_000, minScore: 70 })?.token,
    "AERO"
  );
});

test("selectSmartMoneyCandidate: net flow が無い/0 の行は方向が無いので候補にしない", () => {
  assert.equal(
    selectSmartMoneyCandidate([{ token: "AERO", score: 99, smWallets: 50 }], OPEN),
    undefined
  );
  assert.equal(
    selectSmartMoneyCandidate([{ token: "AERO", score: 99, smWallets: 50, netFlowUsd: 0 }], OPEN),
    undefined
  );
});

test("selectSmartMoneyCandidate: 空なら候補なし", () => {
  assert.equal(selectSmartMoneyCandidate([], OPEN), undefined);
});

test("describeRows: 閾値決めのために実データをそのまま出す", () => {
  const [line] = describeRows(extractSmartMoneyRows(screener), 1);
  assert.equal(line, "#1 AERO(base) score=82 netFlow24h=5200000 smWallets=14");
});

// ── スコアリング ─────────────────────────────────────────────────────────────

test("scoreSmartMoney: 候補なしは SKIP / neutral / 0", () => {
  const d = scoreSmartMoney(undefined);
  assert.equal(d.action, "SKIP");
  assert.equal(d.direction, "neutral");
  assert.equal(d.score, 0);
  assert.equal(d.sizeUsdProposal, 0);
});

test("scoreSmartMoney: 流入 + 高スコアで BUY long", () => {
  const d = scoreSmartMoney({
    token: "AERO",
    netFlowUsd: 8_000_000,
    direction: 1,
    normalizedScore: 0.82,
    score: 82,
    scoreScale: 100,
  });
  // flow 0.8×0.6 + score 0.82×0.4 = 0.808
  assert.equal(d.score, 0.81);
  assert.equal(d.action, "BUY");
  assert.equal(d.direction, "long");
  assert.ok(d.sizeUsdProposal > 0 && d.sizeUsdProposal <= 10);
});

test("scoreSmartMoney: 符号は net flow だけが決める(score は強さのみ)", () => {
  const d = scoreSmartMoney({
    token: "DEGEN",
    netFlowUsd: -8_000_000,
    direction: -1,
    normalizedScore: 0.9,
    scoreScale: 100,
  });
  assert.equal(d.direction, "short");
  assert.ok(d.score < 0);
});

test("scoreSmartMoney: score が無い候補は flow だけで評価する(推測で埋めない)", () => {
  const d = scoreSmartMoney({ token: "X", netFlowUsd: 10_000_000, direction: 1 });
  assert.equal(d.breakdown.scoreComponent, 0);
  assert.equal(d.score, 0.6); // flow 1.0 × 0.6
});

test("scoreSmartMoney: 小さすぎる材料は SKIP、スコアは [-1,1] に収まる", () => {
  const weak = scoreSmartMoney({
    token: "BRETT",
    netFlowUsd: 300_000,
    direction: 1,
    normalizedScore: 0.1,
  });
  assert.equal(weak.action, "SKIP"); // 0.03×0.6 + 0.1×0.4 = 0.058 < 0.15
  assert.equal(weak.sizeUsdProposal, 0);

  const huge = scoreSmartMoney({
    token: "AERO",
    netFlowUsd: 500_000_000,
    direction: 1,
    normalizedScore: 1,
  });
  assert.equal(huge.score, 1);
  assert.ok(huge.sizeUsdProposal <= 10);
});
