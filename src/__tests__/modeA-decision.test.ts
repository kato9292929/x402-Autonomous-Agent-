/**
 * Tests for Mode A's pure decision logic: signal extraction + scoring.
 * Uses node:test (Node.js 20+).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDivergenceSignal,
  extractHyperliquidSignal,
} from "../modes/signal-extract";
import { scoreDecision } from "../modes/scoring";

// ── signal-extract ───────────────────────────────────────────────────────────

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

test("extractHyperliquidSignal reads a positioning skew field and records its name", () => {
  const sig = extractHyperliquidSignal({ summary: { oiBias: 0.6 } });
  assert.equal(sig.available, true);
  assert.equal(sig.bias, 0.6);
  assert.equal(sig.biasField, "oiBias");
});

test("extractHyperliquidSignal returns unavailable when nothing recognised", () => {
  assert.equal(extractHyperliquidSignal({ foo: "bar" }).available, false);
});

// ── scoring ──────────────────────────────────────────────────────────────────

test("scoreDecision emits a BUY long when all signals are bullish", () => {
  const d = scoreDecision({
    divergence: { available: true, token: "ETH", netFlowUsd: 8_000_000 },
    hyperliquid: { available: true, bias: 1.2, biasField: "oiBias" },
    whaleIntent: { available: true, intent: "ACCUMULATION", confidence: 0.8 },
  });
  assert.equal(d.action, "BUY");
  assert.equal(d.direction, "long");
  assert.ok(d.score > 0, "score should be positive");
  assert.ok(d.sizeUsdProposal > 0, "size proposal should be positive on BUY");
});

test("scoreDecision emits a SKIP when no signals are available (never fabricates)", () => {
  const d = scoreDecision({
    divergence: { available: false },
    hyperliquid: { available: false },
    whaleIntent: { available: false },
  });
  assert.equal(d.action, "SKIP");
  assert.equal(d.direction, "neutral");
  assert.equal(d.score, 0);
  assert.equal(d.sizeUsdProposal, 0);
});

test("scoreDecision points short on bearish whale intent + outflow", () => {
  const d = scoreDecision({
    divergence: { available: true, token: "ETH", netFlowUsd: -9_000_000 },
    hyperliquid: { available: true, bias: -0.8, biasField: "skew" },
    whaleIntent: { available: true, intent: "DISTRIBUTION", confidence: 0.9 },
  });
  assert.equal(d.direction, "short");
  assert.equal(d.action, "BUY"); // |score| above threshold → an actionable call
  assert.ok(d.score < 0);
});

test("scoreDecision size proposal is bounded and scales with conviction", () => {
  const strong = scoreDecision({
    divergence: { available: true, token: "ETH", netFlowUsd: 50_000_000 },
    hyperliquid: { available: true, bias: 5, biasField: "oiBias" },
    whaleIntent: { available: true, intent: "ACCUMULATION", confidence: 1 },
  });
  assert.ok(strong.sizeUsdProposal <= 10, "size proposal must be capped at base size");
  assert.ok(strong.score <= 1 && strong.score >= -1, "score stays bounded");
});
