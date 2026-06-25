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
