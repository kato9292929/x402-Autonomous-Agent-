/**
 * Daily decision scoring for Mode A.
 *
 * Combines three real signals into one bounded score in [-1, 1]:
 *   - origin     ← Divergence Analyzer net-flow (smart-money inflow/outflow)
 *   - conviction ← Hyperliquid positioning skew
 *   - direction  ← Whale Intent Decoder (intent + confidence)
 *
 * The formula is intentionally simple and fully recorded in the breakdown so
 * every call can be audited. Unavailable signals contribute 0 — they are never
 * back-filled with a guessed value.
 */
import type { DivergenceSignal, HyperliquidSignal } from "./signal-extract";

export interface WhaleIntentSignal {
  available: boolean;
  intent?: string;
  confidence?: number;
}

export interface ScoreBreakdown {
  originComponent: number;
  convictionComponent: number;
  directionComponent: number;
  weights: { origin: number; conviction: number; direction: number };
}

export interface Decision {
  score: number;
  action: "BUY" | "SKIP";
  direction: "long" | "short" | "neutral";
  sizeUsdProposal: number;
  breakdown: ScoreBreakdown;
}

// Weights — direction (whale intent) is the authority, divergence is the trigger.
const W_ORIGIN = 0.35;
const W_CONVICTION = 0.2;
const W_DIRECTION = 0.45;

// Net-flow magnitude (USD) that saturates the origin component to ±1.
const NETFLOW_SATURATION_USD = 10_000_000;
// |score| at or above this emits a BUY; below it emits a SKIP (見送り).
const BUY_THRESHOLD = 0.15;
// Position size scales with conviction, capped at this base.
const BASE_SIZE_USD = 10;

const BULLISH_INTENTS = [
  "ACCUMULATION",
  "POSITION_BUILDING",
  "ACCUMULATING",
  "BUYING",
];
const BEARISH_INTENTS = ["DISTRIBUTION", "SELLING", "REDUCING", "EXIT"];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function intentSign(intent?: string): number {
  if (!intent) return 0;
  const up = intent.toUpperCase();
  if (BULLISH_INTENTS.includes(up)) return 1;
  if (BEARISH_INTENTS.includes(up)) return -1;
  return 0;
}

export function scoreDecision(inputs: {
  divergence: DivergenceSignal;
  hyperliquid: HyperliquidSignal;
  whaleIntent: WhaleIntentSignal;
}): Decision {
  const { divergence, hyperliquid, whaleIntent } = inputs;

  // Origin: signed, bounded smart-money net flow.
  const originComponent = divergence.available && divergence.netFlowUsd !== undefined
    ? clamp(divergence.netFlowUsd / NETFLOW_SATURATION_USD, -1, 1)
    : 0;

  // Conviction: positioning skew, squashed to (-1, 1) to tolerate any scale.
  const convictionComponent = hyperliquid.available && hyperliquid.bias !== undefined
    ? Math.tanh(hyperliquid.bias)
    : 0;

  // Direction: intent sign weighted by the decoder's confidence.
  const confidence = clamp(whaleIntent.confidence ?? 0, 0, 1);
  const directionComponent = whaleIntent.available
    ? intentSign(whaleIntent.intent) * confidence
    : 0;

  const score = clamp(
    W_ORIGIN * originComponent +
      W_CONVICTION * convictionComponent +
      W_DIRECTION * directionComponent,
    -1,
    1
  );

  const action: Decision["action"] = Math.abs(score) >= BUY_THRESHOLD ? "BUY" : "SKIP";
  const direction: Decision["direction"] =
    score > 0 ? "long" : score < 0 ? "short" : "neutral";
  const sizeUsdProposal =
    action === "BUY" ? round2(BASE_SIZE_USD * Math.abs(score)) : 0;

  return {
    score: round2(score),
    action,
    direction,
    sizeUsdProposal,
    breakdown: {
      originComponent: round2(originComponent),
      convictionComponent: round2(convictionComponent),
      directionComponent: round2(directionComponent),
      weights: { origin: W_ORIGIN, conviction: W_CONVICTION, direction: W_DIRECTION },
    },
  };
}
