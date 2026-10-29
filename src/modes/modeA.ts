/**
 * Mode A — daily decision loop.
 *
 * Since 2026-09 the candidate comes from the Smart Money Screener alone. It
 * reuses the screener response Mode B already paid for (no re-fetch, no double
 * charge), picks the strongest row that clears the thresholds, takes its
 * direction from the sign of the 24h net flow, and records exactly one daily
 * call (BUY / SKIP + direction + size proposal) to an append-only store tied to
 * the ERC-8004 agentId.
 *
 * What was removed, and why:
 *   - Whale Intent Decoder ($0.30/day) — it was being asked about Hyperliquid
 *     tokens with no whale activity on any EVM chain, and answered NO_DATA.
 *   - Hyperliquid Intelligence ($0.20/day) — it was Mode A's candidate source
 *     and nothing else read it, so Mode B stopped buying it too.
 * Mode A now pays nothing: every input is a response Mode B already holds.
 *
 * Scope guard: the execution endpoint (smct /api/execute) is intentionally NOT
 * wired here. Records carry executed:false — they describe what the agent
 * decided, never a fill or P&L.
 */
import { ENDPOINTS_MODE_B } from "../config";
import { AGENT_REGISTRY_ID } from "../erc8004/contract";
import type { RunLog, EndpointResult } from "../types";
import { logRun } from "../logger";
import { saveRun } from "../store/run-store";
import {
  extractDivergenceSignal,
  extractSmartMoneyRows,
  selectSmartMoneyCandidate,
  describeRows,
  type SmartMoneyThresholds,
} from "./signal-extract";
import { scoreSmartMoney } from "./scoring";
import { appendDecision, type DecisionRecord } from "../store/decision-store";

const DEFAULT_AGENT_ID = "55560";

/**
 * Entry thresholds for a screener row.
 *
 * The defaults are deliberately permissive: the screener has only ever been
 * observed empty (it was pointed at Solana, which Nansen does not cover), so
 * the real scale of `score` and `netFlow24h` is not known yet. Mode A pays
 * nothing now, so a loose threshold costs a record rather than money — and the
 * run logs the top rows verbatim, which is what the real thresholds should be
 * set from once a populated response exists.
 */
function thresholds(): SmartMoneyThresholds {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.warn(`[MODE A] threshold "${raw}" is not a number; using ${fallback}`);
      return fallback;
    }
    return n;
  };
  return {
    minScore: num(process.env.SMS_MIN_SCORE, 0),
    minNetFlowUsd: num(process.env.SMS_MIN_NET_FLOW_USD, 0),
    minSmWallets: num(process.env.SMS_MIN_SM_WALLETS, 1),
  };
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

  // ── Reuse Mode B responses (no re-fetch, no payment) ─────────────────────
  const smsResult = findModeBResult(modeBLog, "smart-money-screener");
  const divResult = findModeBResult(modeBLog, "divergence-analyzer");
  const divergence = extractDivergenceSignal(divResult?.fullData);

  if (!modeBLog) {
    log.errors.push("Mode B results not provided — Smart Money Screener unavailable");
    console.warn("[MODE A] No Mode B log passed; no candidate source");
  }

  const rows = extractSmartMoneyRows(smsResult?.fullData);
  const limits = thresholds();
  console.log(
    `[MODE A] Smart Money Screener rows=${rows.length}` +
      ` (thresholds: score≥${limits.minScore}, |netFlow24h|≥$${limits.minNetFlowUsd},` +
      ` smWallets≥${limits.minSmWallets})`
  );
  // Print the rows verbatim: the thresholds above are provisional until someone
  // has seen what the screener actually publishes.
  for (const line of describeRows(rows)) console.log(`[MODE A]   ${line}`);
  if (rows.length === 0 && smsResult) {
    console.warn(
      `[MODE A] Screener returned no usable rows — peek: ${smsResult.responsePeek ?? "(none)"}`
    );
  }

  const candidate = selectSmartMoneyCandidate(rows, limits);
  if (candidate) {
    console.log(
      `[MODE A] Candidate: ${candidate.token}${candidate.chain ? `(${candidate.chain})` : ""}` +
        ` direction=${candidate.direction > 0 ? "long" : "short"}` +
        ` netFlow24h=${candidate.netFlowUsd} score=${candidate.score ?? "?"}` +
        ` (scale ${candidate.scoreScale ?? "?"}) smWallets=${candidate.smWallets ?? "?"}`
    );
  } else {
    console.log("[MODE A] 閾値を満たす行なし — SKIP");
  }

  // ── Score + decide (always emits exactly one call, never exits early) ─────
  const decision = scoreSmartMoney(candidate);

  const rationale =
    `score=${decision.score} → ${decision.action} ${decision.direction}` +
    ` (flow ${decision.breakdown.flowComponent}, screener score ${decision.breakdown.scoreComponent})` +
    (candidate
      ? ` | ${candidate.token} netFlow24h=${candidate.netFlowUsd}`
      : " | Smart Money Screener に閾値を満たす行なし");

  const record: DecisionRecord = {
    date: todayDate(),
    timestamp: new Date().toISOString(),
    agentId,
    agentRegistry: AGENT_REGISTRY_ID,
    signals: {
      smartMoney: {
        available: candidate !== undefined,
        rowCount: rows.length,
        token: candidate?.token,
        chain: candidate?.chain,
        netFlowUsd: candidate?.netFlowUsd,
        score: candidate?.score,
        scoreScale: candidate?.scoreScale,
        smWallets: candidate?.smWallets,
        source: smsResult ? "mode-b-reuse" : "unavailable",
        peek: smsResult?.responsePeek,
      },
      divergence: {
        available: divergence.available,
        token: divergence.token,
        chain: divergence.chain,
        netFlowUsd: divergence.netFlowUsd,
        source: divergence.available ? "mode-b-reuse" : "unavailable",
        peek: divResult?.responsePeek,
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
