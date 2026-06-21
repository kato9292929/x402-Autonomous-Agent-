/**
 * Pure extractors that pull the decision-relevant fields out of the
 * Divergence Analyzer and Hyperliquid Intelligence responses that Mode B
 * already fetched.
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

export interface HyperliquidSignal {
  available: boolean;
  /**
   * Conviction in [-1, 1] = divergenceScore × sign(smartMoneyBias).
   * Positive = smart money LONG, negative = SHORT.
   */
  bias?: number;
  /** How the bias was derived (for audit). */
  biasField?: string;
  /** Token the conviction was read from (must match the decision asset). */
  token?: string;
  /** Raw confirmed field: divergence strength, 0..1. */
  divergenceScore?: number;
  /** Raw confirmed field: "LONG" | "SHORT". */
  smartMoneyBias?: string;
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

function biasSign(smartMoneyBias: string | undefined): number {
  if (!smartMoneyBias) return 0;
  const up = smartMoneyBias.toUpperCase();
  if (up === "LONG") return 1;
  if (up === "SHORT") return -1;
  return 0;
}

/**
 * Read the conviction signal from the Hyperliquid response.
 *
 * The response shape (confirmed from Mode B logs) is:
 *   { topDivergences: [ { token, divergenceScore (0..1), smartMoneyBias: "LONG"|"SHORT", ... } ] }
 *
 * Conviction is derived from the two confirmed fields only — magnitude from
 * divergenceScore, sign from smartMoneyBias — and is matched to the decision
 * asset (`targetToken`, the divergence origin, default ETH). If that token is
 * absent or either confirmed field is unusable, the signal is unavailable and
 * contributes nothing (we never substitute another token or invent a value).
 */
export function extractHyperliquidSignal(
  data: Record<string, unknown> | undefined | null,
  targetToken = "ETH"
): HyperliquidSignal {
  if (!data) return { available: false };
  const target = targetToken.toUpperCase();

  for (const obj of walkObjects(data)) {
    const arr = obj["topDivergences"];
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      if (item === null || typeof item !== "object") continue;
      const el = item as Record<string, unknown>;
      const token = asString(firstKey(el, TOKEN_KEYS)?.value);
      if (!token || token.toUpperCase() !== target) continue;

      const divergenceScore = asNumber(el["divergenceScore"]);
      const smartMoneyBias = asString(el["smartMoneyBias"]);
      const sign = biasSign(smartMoneyBias);
      // Need both confirmed fields; don't fabricate a value or a direction.
      if (divergenceScore === undefined || sign === 0) {
        return { available: false };
      }
      return {
        available: true,
        bias: divergenceScore * sign,
        biasField: "divergenceScore×sign(smartMoneyBias)",
        token,
        divergenceScore,
        smartMoneyBias,
      };
    }
  }

  return { available: false };
}
