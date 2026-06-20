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
  /** Positioning skew. Positive = net-long crowd, negative = net-short. */
  bias?: number;
  /** Which response field the bias was read from (for audit). */
  biasField?: string;
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
const BIAS_KEYS = [
  "oiBias",
  "openInterestBias",
  "positioningBias",
  "netPositioning",
  "longShortSkew",
  "skew",
  "bias",
  "longShortRatio",
];

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

/**
 * Find a positioning-skew value in the Hyperliquid response. Returns the first
 * recognised field; records which field it came from for auditability.
 */
export function extractHyperliquidSignal(
  data: Record<string, unknown> | undefined | null
): HyperliquidSignal {
  if (!data) return { available: false };

  for (const obj of walkObjects(data)) {
    const hit = firstKey(obj, BIAS_KEYS);
    if (!hit) continue;
    const bias = asNumber(hit.value);
    if (bias === undefined) continue;
    return { available: true, bias, biasField: hit.key };
  }

  return { available: false };
}
