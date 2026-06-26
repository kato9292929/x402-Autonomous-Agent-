/** Shared types for the osd (Onchain Stock Data) consumption job. */

/** A pre-authored, machine-verifiable catalyst seeded in config/catalysts.json. */
export interface CatalystSeed {
  /** Stable key used to dedupe submissions across runs. */
  key: string;
  ticker: string;
  /** Numeric / binary, machine-checkable condition (no vague theses). */
  description: string;
  /** Real scheduled date, YYYY-MM-DD. */
  target_date: string;
}

/** A catalyst that AA has submitted to osd and tracks until resolved. */
export interface CatalystRecord {
  catalyst_id: string;
  ticker: string;
  description: string;
  target_date: string;
  submitted_at: string;
  estimated_eval_date?: string;
  score_lookup_url?: string;
  status: "pending" | "hit" | "partial" | "miss" | "na";
  verdict_evidence?: string;
  resolved_at?: string;
  /** The CatalystSeed.key this record came from (for dedupe). */
  seed_key?: string;
}

/** One paid/free osd call recorded for provenance. */
export interface ConsumptionLogEntry {
  endpoint: string;
  price_usd: number;
  network: string; // "base" | "solana" | "free"
  tx_or_settlement_ref: string | null;
  status: number;
  ts: string;
}

/** A JP dated-catalyst seed (config/jp-catalysts.json). */
export interface JpCatalystSeed {
  key: string;
  ticker: string; // 証券コード (e.g. "4062")
  company?: string;
  description: string; // numeric / binary, machine-checkable
  target_date: string; // YYYY-MM-DD (予想日含む)
  thesis: string;
  conviction: number; // AA's prior, 0..1
}

/**
 * A JP catalyst AA generated and tracks. Keyed by seed_key (deterministic);
 * catalyst_id is set only once submitted to osd (gated on osd JP support).
 */
export interface JpCatalystRecord {
  seed_key: string;
  ticker: string;
  company?: string;
  description: string;
  target_date: string;
  thesis: string;
  conviction: number;
  market: "JP";
  agent_id: number; // 55560
  status: "pending" | "hit" | "partial" | "miss" | "na";
  recorded_at: string;
  /** Latest evidence snapshot from perplexity-research (not on-chain). */
  evidence?: string;
  evidence_ref?: string | null; // settlement ref of the evidence call
  evidence_ts?: string;
  /** Set when submitted to osd. */
  catalyst_id?: string;
  submitted_at?: string;
  estimated_eval_date?: string;
  verdict_evidence?: string;
  resolved_at?: string;
}

