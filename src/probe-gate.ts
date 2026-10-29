/**
 * Pre-purchase check against x402 Seller Probe (https://probe.x402jp.com).
 *
 * Before paying a third-party seller, look up GET {PROBE_URL}/scores/{host}:
 *   - the latest paid measurement was not_delivered (paid, nothing delivered) → do not buy;
 *   - buyable_without_input === false and we would call it without input (GET) → do not buy
 *     (a POST endpoint gets its body from bodies.ts, so that flag does not apply to it).
 * The Probe not answering, or having no record of the host, never blocks a purchase: the
 * result of the lookup is only recorded. Our own sellers (OSD, JIN) are never checked.
 */

export const PROBE_URL = (): string => (process.env.PROBE_URL || "https://probe.x402jp.com").replace(/\/$/, "");

/** OSD and JIN, under their public and Vercel hostnames; PROBE_EXEMPT_HOSTS (comma-separated) adds more. */
const OWN_HOSTS = ["osd.x402jp.com", "osd-coral.vercel.app", "jin.x402jp.com", "jin-orcin-pi.vercel.app"];

export function ownHosts(): Set<string> {
  const extra = (process.env.PROBE_EXEMPT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set([...OWN_HOSTS, ...extra]);
}

/** Same host key as the Probe: lowercase hostname, no port, no leading "www.". */
export function probeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface ProbeCheck {
  host: string | null;
  status: "own" | "scored" | "unscored" | "unavailable";
  decision: "buy" | "skip";
  reason?: string;
  score?: number | null;
  buyable_without_input?: boolean | null;
  last_paid_outcome?: string | null;
  last_paid_date?: string | null;
  error?: string;
  checked_at: string;
}

/** Pure: the decision from a /scores/{host} document. */
export function decide(host: string, doc: any, method: "GET" | "POST", now = new Date()): ProbeCheck {
  const outcome: string | null = doc?.last_paid?.outcome ?? null;
  const buyable: boolean | null = typeof doc?.buyable_without_input === "boolean" ? doc.buyable_without_input : null;
  const base: ProbeCheck = {
    host, status: "scored", decision: "buy", score: typeof doc?.score === "number" ? doc.score : null,
    buyable_without_input: buyable, last_paid_outcome: outcome, last_paid_date: doc?.last_paid?.date ?? null,
    checked_at: now.toISOString(),
  };
  if (outcome === "not_delivered")
    return { ...base, decision: "skip", reason: `probe: last paid measurement (${base.last_paid_date}) was not_delivered` };
  if (buyable === false && method === "GET") {
    const why = doc?.requires_input_reason?.reason ?? "not buyable with a bare GET";
    return { ...base, decision: "skip", reason: `probe: buyable_without_input=false (${why})` };
  }
  return base;
}

export async function checkProbe(url: string, method: "GET" | "POST", fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<ProbeCheck> {
  const now = new Date();
  const host = probeHost(url);
  if (host && ownHosts().has(host)) return { host, status: "own", decision: "buy", checked_at: now.toISOString() };
  if (!host) return { host, status: "unavailable", decision: "buy", error: "cannot parse host", checked_at: now.toISOString() };
  try {
    const res = await fetchImpl(`${PROBE_URL()}/scores/${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { host, status: "unscored", decision: "buy", checked_at: now.toISOString() };
    if (!res.ok) return { host, status: "unavailable", decision: "buy", error: `HTTP ${res.status}`, checked_at: now.toISOString() };
    return decide(host, await res.json(), method, now);
  } catch (e: any) {
    return { host, status: "unavailable", decision: "buy", error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e), checked_at: now.toISOString() };
  }
}
