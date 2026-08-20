/**
 * Per-endpoint sample of what the agent actually received.
 *
 * The agent already captures full responses for endpoints configured with
 * `captureFullData`, and saveRun persists them inside each RunLog. This module
 * picks, for every endpoint, the most recent run result that carries a payload
 * and trims it to a size that is safe to serve.
 *
 * Nothing is synthesised: if an endpoint has never returned a captured body,
 * it simply does not appear with a sample. `responsePeek` is used as a fallback
 * so a caller can still see the shape of a response that was not fully captured.
 */
import type { RunLog, EndpointResult } from "../types";

/** Max serialized characters of a single endpoint sample. */
export const SAMPLE_CHAR_CAP = 4000;

export interface EndpointSample {
  /** The called URL, as configured. */
  endpoint: string;
  /** Path only — what the published catalog lists. */
  path: string;
  product: string;
  status: EndpointResult["status"];
  costUsdc: number;
  txHash?: string;
  /** Timestamp of the run this sample came from. */
  at: string;
  /** The captured response body, trimmed. Absent when nothing was captured. */
  sample?: unknown;
  /** True when `sample` was cut to fit SAMPLE_CHAR_CAP. */
  truncated?: boolean;
  /** Short excerpt the agent logs for every call, captured or not. */
  peek?: string;
}

/** Path of a configured endpoint URL; returns the input unchanged if unparseable. */
export function pathOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).pathname;
  } catch {
    return url;
  }
}

/**
 * Trim a captured body so its JSON stays under the cap.
 *
 * Arrays are shortened element-by-element (keeping the head) rather than being
 * string-sliced, so the result is still valid JSON the UI can render. Objects
 * too large even when empty of arrays fall back to a string excerpt.
 */
export function trimSample(value: unknown, cap = SAMPLE_CHAR_CAP): { value: unknown; truncated: boolean } {
  const full = JSON.stringify(value);
  if (full === undefined) return { value: undefined, truncated: false };
  if (full.length <= cap) return { value, truncated: false };

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(item);
      if (JSON.stringify(out)!.length > cap) {
        out.pop();
        break;
      }
    }
    return { value: out, truncated: true };
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const trimmedChild = Array.isArray(v) ? trimSample(v, Math.floor(cap / 2)).value : v;
      out[k] = trimmedChild;
      if (JSON.stringify(out)!.length > cap) {
        delete out[k];
        break;
      }
    }
    return { value: out, truncated: true };
  }

  return { value: String(full).slice(0, cap), truncated: true };
}

/**
 * Build one sample per endpoint from the given runs, newest wins.
 * A result with a captured body always beats one without.
 */
export function buildSamples(runs: RunLog[]): EndpointSample[] {
  const byEndpoint = new Map<string, { at: string; result: EndpointResult }>();

  for (const run of runs) {
    for (const result of run.results ?? []) {
      if (!result.endpoint) continue;
      const prev = byEndpoint.get(result.endpoint);
      if (!prev) {
        byEndpoint.set(result.endpoint, { at: run.timestamp, result });
        continue;
      }
      const prevHasData = prev.result.fullData !== undefined;
      const thisHasData = result.fullData !== undefined;
      // Prefer a captured body; among equals, prefer the newer run.
      if ((thisHasData && !prevHasData) ||
          (thisHasData === prevHasData && new Date(run.timestamp) > new Date(prev.at))) {
        byEndpoint.set(result.endpoint, { at: run.timestamp, result });
      }
    }
  }

  return [...byEndpoint.values()].map(({ at, result }) => {
    const trimmed = result.fullData !== undefined ? trimSample(result.fullData) : undefined;
    const out: EndpointSample = {
      endpoint: result.endpoint,
      path: pathOf(result.endpoint),
      product: result.product,
      status: result.status,
      costUsdc: result.costUsdc,
      at,
    };
    if (result.txHash) out.txHash = result.txHash;
    if (trimmed) {
      out.sample = trimmed.value;
      if (trimmed.truncated) out.truncated = true;
    }
    if (result.responsePeek) out.peek = result.responsePeek;
    return out;
  });
}
