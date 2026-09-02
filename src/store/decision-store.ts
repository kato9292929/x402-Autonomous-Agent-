/**
 * Append-only store for Mode A daily decisions.
 *
 * Backends (a record is written to every backend that is configured):
 *   1. Upstash Redis REST — RPUSH onto a per-agent list, when
 *      UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 *   2. Local JSONL file (data/decisions/mode-a-decisions.jsonl) — always.
 *      Append-only; matches Mode B's existing data/ persistence pattern.
 *
 * Records are immutable: we only ever append. Nothing here executes a trade.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * Signals behind one decision.
 *
 * Shape as of 2026-09: the Smart Money Screener is the candidate source, and
 * the Hyperliquid / Whale Intent fields are gone with the endpoints. Records
 * written before that keep their own shape — the store is append-only and old
 * records are never rewritten, so a reader spanning the change sees both.
 */
export interface DecisionSignals {
  smartMoney: {
    available: boolean;
    /** How many rows the screener returned (0 is the finding, not an error). */
    rowCount: number;
    token?: string;
    chain?: string;
    /** 24h net flow, USD. Its sign is the recorded direction. */
    netFlowUsd?: number;
    score?: number;
    /** Divisor used to map `score` onto 0..1, so the mapping is auditable. */
    scoreScale?: number;
    smWallets?: number;
    source: "mode-b-reuse" | "unavailable";
    peek?: string;
  };
  divergence: {
    available: boolean;
    token?: string;
    chain?: string;
    netFlowUsd?: number;
    source: "mode-b-reuse" | "unavailable";
    peek?: string;
  };
}

export interface DecisionRecord {
  date: string; // YYYY-MM-DD
  timestamp: string; // ISO 8601
  agentId: string; // ERC-8004 agentId (e.g. "55560")
  agentRegistry?: string; // ERC-8004 registry CAIP-10 for traceability
  signals: DecisionSignals;
  score: number;
  call: {
    action: "BUY" | "SKIP";
    direction: "long" | "short" | "neutral";
    sizeUsdProposal: number;
  };
  rationale: string;
  scoreBreakdown: Record<string, unknown>;
  costUsdc: number; // payments made by Mode A this run (wid only)
  executed: false; // execution is intentionally not wired in this scope
}

function localFilePath(): string {
  return path.join(process.cwd(), "data", "decisions", "mode-a-decisions.jsonl");
}

function appendLocal(record: DecisionRecord): void {
  const file = localFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  console.log(`[MODE A] Decision appended → ${file}`);
}

async function appendUpstash(record: DecisionRecord): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return; // backend not configured — silently skip

  const key = `trade_agent_daily:${record.agentId}`;
  const endpoint = `${url.replace(/\/$/, "")}/rpush/${encodeURIComponent(key)}`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      console.warn(`[MODE A] Upstash RPUSH failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return;
    }
    console.log(`[MODE A] Decision appended → Upstash (${key})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MODE A] Upstash RPUSH error: ${msg}`);
  }
}

/** Append one decision to every configured backend. Local write is fatal-safe. */
export async function appendDecision(record: DecisionRecord): Promise<void> {
  appendLocal(record);
  await appendUpstash(record);
}

/**
 * Read all Mode A daily decisions for an agent (trade_agent_daily:{agentId}).
 * Upstash(LRANGE) が使えればそれ、無ければローカル JSONL を読む。読み取り専用。
 */
export async function loadDecisions(agentId: string): Promise<DecisionRecord[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const key = `trade_agent_daily:${agentId}`;
    const endpoint = `${url.replace(/\/$/, "")}/lrange/${encodeURIComponent(key)}/0/-1`;
    try {
      const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const json = (await res.json()) as { result?: string[] };
        return (json.result ?? [])
          .map((s) => JSON.parse(s) as DecisionRecord)
          .filter((r) => r.agentId === agentId);
      }
      console.warn(`[MODE A] Upstash LRANGE failed: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[MODE A] Upstash LRANGE error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // local fallback
  try {
    return fs
      .readFileSync(localFilePath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DecisionRecord)
      .filter((r) => r.agentId === agentId);
  } catch {
    return [];
  }
}
