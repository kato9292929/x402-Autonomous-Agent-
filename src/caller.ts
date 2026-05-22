import { fetchWithX402 } from "./x402";
import { getRequestBody } from "./bodies";
import type { EndpointConfig } from "./config";
import type { EndpointResult } from "./types";

// In-memory consecutive failure counter (persists across cron runs while process is alive)
const failureCounts = new Map<string, number>();

export async function callEndpoint(ep: EndpointConfig): Promise<EndpointResult> {
  const startMs = Date.now();

  try {
    const options: RequestInit =
      ep.method === "POST"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(getRequestBody(ep.id) ?? {}),
          }
        : {};

    const res = await fetchWithX402(ep.url, options);
    const data = (await res.json()) as Record<string, unknown>;

    failureCounts.set(ep.id, 0);

    return {
      endpoint: ep.url,
      product: ep.name,
      status: "success",
      costUsdc: ep.cost,
      responsePeek: JSON.stringify(data).slice(0, 120),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const prev = failureCounts.get(ep.id) ?? 0;
    failureCounts.set(ep.id, prev + 1);

    const error = err instanceof Error ? err.message : String(err);
    return {
      endpoint: ep.url,
      product: ep.name,
      status: "error",
      costUsdc: 0,
      responsePeek: "",
      error,
      durationMs: Date.now() - startMs,
    };
  }
}

export function getConsecutiveFailures(ep: EndpointConfig): number {
  return failureCounts.get(ep.id) ?? 0;
}
