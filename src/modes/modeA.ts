/**
 * Mode A — daily decision loop.
 *
 * Mode A no longer gates on the (empty) Smart Money Screener and no longer
 * exits early. It runs every day, reuses the Divergence Analyzer and
 * Hyperliquid Intelligence responses that Mode B already paid for (no
 * re-fetch, no double charge), pays once for the Whale Intent Decoder to read
 * direction, scores the three signals, and records exactly one daily call
 * (BUY / SKIP + direction + size proposal) to an append-only store tied to the
 * ERC-8004 agentId.
 *
 * Scope guard: the execution endpoint (smct /api/execute) is intentionally NOT
 * wired here. Records carry executed:false — they describe what the agent
 * decided, never a fill or P&L.
 */
import { fetchWithPayment } from "../x402";
import { ENDPOINTS_MODE_B } from "../config";
import { AGENT_REGISTRY_ID } from "../erc8004/contract";
import type { RunLog, EndpointResult } from "../types";
import { logRun } from "../logger";
import { saveRun } from "../store/run-store";
import {
  extractDivergenceSignal,
  extractHyperliquidSignal,
  selectHyperliquidCandidate,
  type DecodeCandidate,
} from "./signal-extract";
import { scoreDecision, type WhaleIntentSignal } from "./scoring";
import { appendDecision, type DecisionRecord } from "../store/decision-store";

const DEFAULT_AGENT_ID = "55560";
const WID_COST_USDC = 0.3;
/** Hyperliquid divergences below this score never open the Decoder gate. */
const DEFAULT_HL_DIVERGENCE_MIN_SCORE = 0.75;

/** Threshold from the AA-side env; a malformed value falls back to the default. */
function hlDivergenceMinScore(): number {
  const raw = process.env.HL_DIVERGENCE_MIN_SCORE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HL_DIVERGENCE_MIN_SCORE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[MODE A] HL_DIVERGENCE_MIN_SCORE="${raw}" is not a number; using ${DEFAULT_HL_DIVERGENCE_MIN_SCORE}`
    );
    return DEFAULT_HL_DIVERGENCE_MIN_SCORE;
  }
  return parsed;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Find a Mode B result by endpoint id (matched via its configured URL). */
function findModeBResult(
  modeBLog: RunLog | undefined,
  endpointId: string
): EndpointResult | undefined {
  if (!modeBLog) return undefined;
  const ep = ENDPOINTS_MODE_B.find((e) => e.id === endpointId);
  if (!ep) return undefined;
  return modeBLog.results.find((r) => r.endpoint === ep.url);
}

export async function runModeA(modeBLog?: RunLog): Promise<void> {
  const startMs = Date.now();
  console.log("[MODE A] Daily decision run started");

  const agentId = process.env.ERC8004_AGENT_ID ?? DEFAULT_AGENT_ID;
  const log: RunLog = {
    timestamp: new Date().toISOString(),
    mode: "A",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 0,
    errors: [],
  };

  // ── Reuse Mode B signals (no re-fetch) ───────────────────────────────────
  const divResult = findModeBResult(modeBLog, "divergence-analyzer");
  const hlResult = findModeBResult(modeBLog, "hyperliquid-intelligence");
  const divergence = extractDivergenceSignal(divResult?.fullData);
  // Match conviction to the decision asset (the divergence origin, default ETH).
  const hyperliquid = extractHyperliquidSignal(hlResult?.fullData, divergence.token);

  if (!modeBLog) {
    log.errors.push("Mode B results not provided — divergence/hyperliquid unavailable");
    console.warn("[MODE A] No Mode B log passed; signals unavailable");
  }
  console.log(
    `[MODE A] Divergence available=${divergence.available}` +
      (divergence.available
        ? ` token=${divergence.token ?? "?"} netFlowUsd=${divergence.netFlowUsd}`
        : "")
  );
  console.log(
    `[MODE A] Hyperliquid available=${hyperliquid.available}` +
      (hyperliquid.available
        ? ` ${hyperliquid.token} conviction=${hyperliquid.bias}` +
          ` (divergenceScore=${hyperliquid.divergenceScore}, smartMoneyBias=${hyperliquid.smartMoneyBias})`
        : "")
  );

  // ── Whale Intent Decoder — direction (the only paid call in Mode A) ───────
  //
  // The gate used to read the Divergence Analyzer alone, and that endpoint has
  // returned an empty `results` array on every run, so the Decoder never fired.
  // Hyperliquid is already bought each day and does carry divergences, so it now
  // serves as a second source for the same gate. The Analyzer still wins when it
  // has something, so this only adds days, never changes existing ones.
  //
  // The gate is local and free: with no candidate nothing is POSTed and the day
  // costs $0.
  const analyzerCandidate: DecodeCandidate | undefined =
    divergence.available && divergence.token
      ? {
          token: divergence.token,
          source: "analyzer",
          chain: divergence.chain,
          netFlowUsd: divergence.netFlowUsd,
        }
      : undefined;
  const candidate =
    analyzerCandidate ??
    selectHyperliquidCandidate(hlResult?.fullData, hlDivergenceMinScore());

  let whaleIntent: WhaleIntentSignal = { available: false };
  let widCost = 0;
  if (candidate) {
    console.log(
      `[MODE A] Decode candidate: ${candidate.token} (source=${candidate.source}` +
        (candidate.divergenceScore !== undefined
          ? `, divergenceScore=${candidate.divergenceScore}, bias=${candidate.smartMoneyBias}`
          : "") +
        ")"
    );
    try {
      const widUrl =
        process.env.WHALE_INTENT_DECODER_URL ?? "https://x402wid.vercel.app/api/decode";
      // Each source has its own request shape; send only what that source knows.
      const body =
        candidate.source === "hyperliquid"
          ? {
              token: candidate.token,
              divergenceScore: candidate.divergenceScore,
              smartMoneyBias: candidate.smartMoneyBias,
            }
          : {
              token: candidate.token,
              chain: candidate.chain ?? "ethereum",
              amount: candidate.netFlowUsd ?? 0,
            };
      const decodeRes = await fetchWithPayment(widUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!decodeRes.ok) {
        const text = await decodeRes.text().catch(() => "(no body)");
        throw new Error(`HTTP ${decodeRes.status}: ${text.slice(0, 200)}`);
      }
      const decoded = (await decodeRes.json()) as {
        intent?: string;
        confidence?: number;
      };
      widCost = WID_COST_USDC;
      whaleIntent = {
        available: true,
        intent: decoded.intent,
        confidence: decoded.confidence,
      };
      log.results.push({
        endpoint: "/api/decode",
        product: "Whale Intent Decoder",
        status: "success",
        costUsdc: WID_COST_USDC,
        responsePeek: JSON.stringify(decoded).slice(0, 120),
        durationMs: 0,
      });
      log.totalCostUsdc += WID_COST_USDC;
      log.totalTxCount += 1;
      console.log(
        `[MODE A] Whale Intent — intent=${decoded.intent} confidence=${decoded.confidence}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.errors.push(`Whale Intent Decoder: ${msg}`);
      console.error(`[MODE A] Whale Intent Decoder failed: ${msg}`);
    }
  } else {
    console.log(
      `[MODE A] No decode candidate (analyzer empty, no Hyperliquid divergence ≥ ${hlDivergenceMinScore()})` +
        " — skipping Whale Intent Decoder ($0)"
    );
  }

  // ── Score + decide (always emits exactly one call, never exits early) ─────
  const decision = scoreDecision({ divergence, hyperliquid, whaleIntent });

  const missing: string[] = [];
  if (!divergence.available) missing.push("divergence");
  if (!hyperliquid.available) missing.push("hyperliquid");
  if (!whaleIntent.available) missing.push("whaleIntent");
  const rationale =
    `score=${decision.score} → ${decision.action} ${decision.direction}` +
    ` (origin ${decision.breakdown.originComponent}, conviction ${decision.breakdown.convictionComponent},` +
    ` direction ${decision.breakdown.directionComponent})` +
    (missing.length > 0 ? ` | unavailable: ${missing.join(", ")}` : "");

  const record: DecisionRecord = {
    date: todayDate(),
    timestamp: new Date().toISOString(),
    agentId,
    agentRegistry: AGENT_REGISTRY_ID,
    signals: {
      divergence: {
        available: divergence.available,
        token: divergence.token,
        chain: divergence.chain,
        netFlowUsd: divergence.netFlowUsd,
        source: divergence.available ? "mode-b-reuse" : "unavailable",
        peek: divResult?.responsePeek,
      },
      hyperliquid: {
        available: hyperliquid.available,
        bias: hyperliquid.bias,
        biasField: hyperliquid.biasField,
        token: hyperliquid.token,
        divergenceScore: hyperliquid.divergenceScore,
        smartMoneyBias: hyperliquid.smartMoneyBias,
        source: hyperliquid.available ? "mode-b-reuse" : "unavailable",
        peek: hlResult?.responsePeek,
      },
      whaleIntent: {
        available: whaleIntent.available,
        intent: whaleIntent.intent,
        confidence: whaleIntent.confidence,
        source: whaleIntent.available ? "wid" : "unavailable",
        candidateSource: candidate?.source,
        candidateToken: candidate?.token,
        costUsdc: widCost,
      },
    },
    score: decision.score,
    call: {
      action: decision.action,
      direction: decision.direction,
      sizeUsdProposal: decision.sizeUsdProposal,
    },
    rationale,
    scoreBreakdown: decision.breakdown as unknown as Record<string, unknown>,
    costUsdc: log.totalCostUsdc,
    executed: false,
  };

  try {
    await appendDecision(record);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.errors.push(`Decision store: ${msg}`);
    console.error(`[MODE A] Failed to persist decision: ${msg}`);
  }

  console.log(
    `[MODE A] Daily call — ${decision.action} ${decision.direction} ` +
      `size=$${decision.sizeUsdProposal} (agentId=${agentId}) [executed=false]`
  );

  log.durationMs = Date.now() - startMs;
  logRun(log);
  await saveRun(log);
  console.log(`[MODE A] Complete. $${log.totalCostUsdc.toFixed(2)} USDC spent`);
}
