/**
 * Thin osd API client.
 *
 * Free Phase A endpoints (CORS-open, no payment) use plain fetch. Paid x402
 * endpoints reuse the agent's existing payment client (fetchWithPayment); the
 * x402 client auto-selects the Base (Circle DCW) or Solana (svm exact) leg from
 * the 402 challenge, so Solana-only endpoints settle on the Solana leg.
 */
import { decodePaymentResponseHeader } from "@x402/fetch";
import { fetchWithPayment } from "../x402";

export function osdBase(): string {
  return process.env.OSD_API_BASE ?? "https://osd-coral.vercel.app";
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ── Free Phase A ─────────────────────────────────────────────────────────────

export interface SubmitCatalystResponse {
  catalyst_id: string;
  status: string;
  estimated_eval_date?: string;
  score_lookup_url?: string;
}

export async function submitCatalyst(body: {
  ticker: string;
  description: string;
  target_date: string;
}): Promise<SubmitCatalystResponse> {
  const url = `${osdBase()}/api/alpha/catalyst/submit`;
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`submit HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as SubmitCatalystResponse;
  });
}

export interface ScoreResponse {
  status: string; // "pending" | "hit" | "partial" | "miss" | "na"
  [k: string]: unknown;
}

/** Returns null when the catalyst id is unknown (404). */
export async function getCatalystScore(catalystId: string): Promise<ScoreResponse | null> {
  const url = `${osdBase()}/api/alpha/catalyst/${encodeURIComponent(catalystId)}/score`;
  return withTimeout(async (signal) => {
    const res = await fetch(url, { signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`score HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as ScoreResponse;
  });
}

// ── Paid x402 ────────────────────────────────────────────────────────────────

export interface PaidCallResult {
  status: number;
  settlementRef: string | null;
  network: string;
}

/**
 * Call a paid x402 endpoint. `expectedNetwork` is used only to label the
 * consumption log if the settlement header doesn't carry a network.
 */
export async function paidCall(
  pathname: string,
  opts: { method?: "GET" | "POST"; body?: unknown; expectedNetwork?: string } = {}
): Promise<PaidCallResult> {
  const url = `${osdBase()}${pathname}`;
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetchWithPayment(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  // Drain body so the connection completes (we don't parse data endpoints).
  await res.text().catch(() => undefined);

  let settlementRef: string | null = null;
  let network = opts.expectedNetwork ?? "base";
  const header =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (header) {
    try {
      const decoded = decodePaymentResponseHeader(header) as {
        transaction?: string;
        network?: string;
      };
      settlementRef = decoded.transaction ?? null;
      if (decoded.network) network = decoded.network;
    } catch {
      // header present but unparseable — leave ref null
    }
  }

  return { status: res.status, settlementRef, network };
}
