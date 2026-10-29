/**
 * Daily decision scoring for Mode A.
 *
 * One source since 2026-09: the Smart Money Screener. The score is built from
 * the two fields the screener publishes per row —
 *   - flow  ← 24h net flow in USD (its sign is the direction)
 *   - score ← the screener's own score, mapped onto 0..1
 * and the number of smart-money wallets acts as an entry threshold rather than
 * a weight, so no invented saturation constant sits between the data and the
 * decision.
 *
 * (Until 2026-09 this combined the Divergence Analyzer, Hyperliquid and the
 * Whale Intent Decoder. The first returned an empty array on every run, the
 * other two were dropped from Mode A along with their $0.50/day.)
 *
 * The formula is fully recorded in the breakdown so every call can be audited.
 */
import type { SmartMoneyCandidate } from "./signal-extract";

export interface ScoreBreakdown {
  flowComponent: number;
  scoreComponent: number;
  weights: { flow: number; score: number };
}

export interface Decision {
  score: number;
  action: "BUY" | "SKIP";
  direction: "long" | "short" | "neutral";
  sizeUsdProposal: number;
  breakdown: ScoreBreakdown;
}

// Weights — the flow is the trigger, the screener's own score is the conviction.
const W_FLOW = 0.6;
const W_SCORE = 0.4;

// Net-flow magnitude (USD) that saturates the flow component to 1.
const NETFLOW_SATURATION_USD = 10_000_000;
// |score| at or above this emits a BUY; below it emits a SKIP (見送り).
const BUY_THRESHOLD = 0.15;
// Position size scales with conviction, capped at this base.
const BASE_SIZE_USD = 10;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Score one screener candidate.
 *
 * The sign is the net flow's sign, never the score's: a large outflow is a
 * short, and the screener's score only says how strong the row is. A candidate
 * with no score contributes its flow alone rather than a guessed conviction.
 */
export function scoreSmartMoney(candidate: SmartMoneyCandidate | undefined): Decision {
  if (!candidate) {
    return {
      score: 0,
      action: "SKIP",
      direction: "neutral",
      sizeUsdProposal: 0,
      breakdown: {
        flowComponent: 0,
        scoreComponent: 0,
        weights: { flow: W_FLOW, score: W_SCORE },
      },
    };
  }

  const flowComponent = clamp(
    Math.abs(candidate.netFlowUsd) / NETFLOW_SATURATION_USD,
    0,
    1
  );
  const scoreComponent = clamp(candidate.normalizedScore ?? 0, 0, 1);
  const magnitude = clamp(W_FLOW * flowComponent + W_SCORE * scoreComponent, 0, 1);
  const score = clamp(candidate.direction * magnitude, -1, 1);

  const action: Decision["action"] = Math.abs(score) >= BUY_THRESHOLD ? "BUY" : "SKIP";
  const direction: Decision["direction"] =
    score > 0 ? "long" : score < 0 ? "short" : "neutral";

  return {
    score: round2(score),
    action,
    direction,
    sizeUsdProposal: action === "BUY" ? round2(BASE_SIZE_USD * Math.abs(score)) : 0,
    breakdown: {
      flowComponent: round2(flowComponent),
      scoreComponent: round2(scoreComponent),
      weights: { flow: W_FLOW, score: W_SCORE },
    },
  };
}
