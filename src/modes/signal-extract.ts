/**
 * Pure extractors that pull the decision-relevant fields out of the responses
 * Mode B already fetched — since 2026-09 that means the Smart Money Screener,
 * which is now Mode A's only candidate source.
 *
 * (The Hyperliquid extractors lived here until the same change. Mode A stopped
 * reading them and Mode B stopped buying the endpoint, so they were removed
 * rather than left as an unused second opinion.)
 *
 * The live response shapes could not be confirmed from this environment
 * (network egress is blocked), so extraction is deliberately tolerant: it
 * searches the object tree for the documented field names and a few obvious
 * variants. When nothing is found, `available` is false and the numeric
 * fields are left undefined — we never invent a value.
 */

export interface DivergenceSignal {
  available: boolean;
  token?: string;
  chain?: string;
  netFlowUsd?: number;
}

// Field-name candidates, ordered by how closely they match the documented name.
const NETFLOW_KEYS = [
  "nansenNetFlowUsd",
  "netFlowUsd",
  "netflowUsd",
  "netFlow",
  "net_flow_usd",
];
const TOKEN_KEYS = ["token", "symbol", "asset", "ticker"];
const CHAIN_KEYS = ["chain", "network", "blockchain"];

function asNumber(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asString(val: unknown): string | undefined {
  return typeof val === "string" && val.trim() !== "" ? val : undefined;
}

/** Breadth-first walk over plain objects/arrays, yielding every object node. */
function* walkObjects(root: unknown): Generator<Record<string, unknown>> {
  const queue: unknown[] = [root];
  let guard = 0;
  while (queue.length > 0 && guard < 5000) {
    guard++;
    const node = queue.shift();
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
    } else if (node !== null && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      yield obj;
      for (const v of Object.values(obj)) {
        if (v !== null && typeof v === "object") queue.push(v);
      }
    }
  }
}

function firstKey(
  obj: Record<string, unknown>,
  keys: string[]
): { key: string; value: unknown } | undefined {
  for (const k of keys) {
    if (k in obj && obj[k] !== null && obj[k] !== undefined) {
      return { key: k, value: obj[k] };
    }
  }
  return undefined;
}

/**
 * Find the strongest divergence candidate: the object carrying a net-flow value
 * (and ideally a token). Picks the entry with the largest |netFlowUsd|.
 */
export function extractDivergenceSignal(
  data: Record<string, unknown> | undefined | null
): DivergenceSignal {
  if (!data) return { available: false };

  let best: DivergenceSignal | undefined;
  for (const obj of walkObjects(data)) {
    const nf = firstKey(obj, NETFLOW_KEYS);
    if (!nf) continue;
    const netFlowUsd = asNumber(nf.value);
    if (netFlowUsd === undefined) continue;

    const token = asString(firstKey(obj, TOKEN_KEYS)?.value);
    const chain = asString(firstKey(obj, CHAIN_KEYS)?.value);
    const candidate: DivergenceSignal = {
      available: true,
      token,
      chain,
      netFlowUsd,
    };
    if (!best || Math.abs(netFlowUsd) > Math.abs(best.netFlowUsd ?? 0)) {
      best = candidate;
    }
  }

  return best ?? { available: false };
}

// ── Smart Money Screener ────────────────────────────────────────────────────

/** One screener row, as far as it can be read. */
export interface SmartMoneyRow {
  token: string;
  chain?: string;
  /** Number of smart-money wallets behind the row. */
  smWallets?: number;
  /** 24h net flow in USD. The sign is the direction. */
  netFlowUsd?: number;
  /** The screener's own score, on whatever scale it publishes. */
  score?: number;
  rank?: number;
}

export interface SmartMoneyCandidate extends SmartMoneyRow {
  netFlowUsd: number;
  /** +1 = inflow (long), -1 = outflow (short). Read from the net-flow sign only. */
  direction: 1 | -1;
  /** score mapped to 0..1 using `scoreScale`. Undefined when there is no score. */
  normalizedScore?: number;
  /** The divisor used for `normalizedScore`, recorded so the mapping is auditable. */
  scoreScale?: number;
}

export interface SmartMoneyThresholds {
  minScore: number;
  minNetFlowUsd: number;
  minSmWallets: number;
}

const SM_WALLET_KEYS = [
  "smWallets",
  "smartMoneyWallets",
  "sm_wallets",
  "smart_money_wallets",
  "walletCount",
  "wallets",
];
const SM_NETFLOW_KEYS = [
  "netFlow24h",
  "netFlowUsd24h",
  "net_flow_24h",
  "netFlowUsd",
  "netflowUsd",
  "net_flow_usd",
  "netFlow",
];
const SM_SCORE_KEYS = ["score", "smartMoneyScore", "smart_money_score", "sm_score"];
const SM_RANK_KEYS = ["rank", "position"];

/**
 * The rows of a screener response, wherever the array happens to live.
 *
 * The live shape has only been seen empty (`{tokens: [], total_scanned: 0}`
 * while it was pointed at Solana), so this reads any array of objects that
 * carries a token together with at least one of the three decision fields. It
 * never manufactures a row.
 */
export function extractSmartMoneyRows(
  data: Record<string, unknown> | undefined | null
): SmartMoneyRow[] {
  if (!data) return [];
  const rows: SmartMoneyRow[] = [];

  for (const obj of walkObjects(data)) {
    for (const value of Object.values(obj)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const el = item as Record<string, unknown>;
        const token = asString(firstKey(el, TOKEN_KEYS)?.value);
        if (!token) continue;

        const row: SmartMoneyRow = {
          token,
          chain: asString(firstKey(el, CHAIN_KEYS)?.value),
          smWallets: asNumber(firstKey(el, SM_WALLET_KEYS)?.value),
          netFlowUsd: asNumber(firstKey(el, SM_NETFLOW_KEYS)?.value),
          score: asNumber(firstKey(el, SM_SCORE_KEYS)?.value),
          rank: asNumber(firstKey(el, SM_RANK_KEYS)?.value),
        };
        // A row with none of the three decision fields is not a screener row.
        if (row.smWallets === undefined && row.netFlowUsd === undefined && row.score === undefined) {
          continue;
        }
        if (!rows.some((r) => r.token === row.token && r.chain === row.chain)) rows.push(row);
      }
    }
  }
  return rows;
}

/**
 * Divisor that maps the screener's score onto 0..1.
 *
 * The published scale is not documented anywhere we can read, so it is inferred
 * from the rows themselves on a fixed ladder (1 / 10 / 100) rather than from the
 * day's maximum — the latter would make the same score mean different things on
 * different days. The chosen scale is recorded on the decision.
 */
export function scoreScaleOf(rows: SmartMoneyRow[]): number | undefined {
  const scores = rows.map((r) => r.score).filter((s): s is number => s !== undefined);
  if (scores.length === 0) return undefined;
  const max = Math.max(...scores);
  if (max <= 1) return 1;
  if (max <= 10) return 10;
  if (max <= 100) return 100;
  return max;
}

/**
 * Pick the strongest row that clears every threshold.
 *
 * Direction comes from the sign of the 24h net flow and nothing else — a row
 * with no net flow has no direction, and a direction is never inferred from the
 * score. Ranking is by score, with |net flow| as the tie-break.
 */
export function selectSmartMoneyCandidate(
  rows: SmartMoneyRow[],
  thresholds: SmartMoneyThresholds
): SmartMoneyCandidate | undefined {
  const scale = scoreScaleOf(rows);
  let best: SmartMoneyCandidate | undefined;

  for (const row of rows) {
    const { netFlowUsd, score, smWallets } = row;
    if (netFlowUsd === undefined || netFlowUsd === 0) continue; // 方向が無い
    if (Math.abs(netFlowUsd) < thresholds.minNetFlowUsd) continue;
    if ((score ?? 0) < thresholds.minScore) continue;
    if ((smWallets ?? 0) < thresholds.minSmWallets) continue;

    const candidate: SmartMoneyCandidate = {
      ...row,
      netFlowUsd,
      direction: netFlowUsd > 0 ? 1 : -1,
      normalizedScore:
        score !== undefined && scale !== undefined ? Math.min(score / scale, 1) : undefined,
      scoreScale: scale,
    };
    if (
      !best ||
      (candidate.score ?? 0) > (best.score ?? 0) ||
      ((candidate.score ?? 0) === (best.score ?? 0) &&
        Math.abs(candidate.netFlowUsd) > Math.abs(best.netFlowUsd))
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Compact, verbatim view of the top rows — what the thresholds should be set from. */
export function describeRows(rows: SmartMoneyRow[], max = 5): string[] {
  return rows.slice(0, max).map(
    (r) =>
      `${r.rank !== undefined ? `#${r.rank} ` : ""}${r.token}` +
      `${r.chain ? `(${r.chain})` : ""} score=${r.score ?? "?"}` +
      ` netFlow24h=${r.netFlowUsd ?? "?"} smWallets=${r.smWallets ?? "?"}`
  );
}
