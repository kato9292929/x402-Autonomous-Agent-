import { fetchWithX402 } from "./x402";
import type { EndpointConfig, EndpointResult } from "./types";

// In-memory consecutive failure counter (persists across cron runs while process is alive)
const failureCounts = new Map<string, number>();

export async function callEndpoint(ep: EndpointConfig): Promise<EndpointResult> {
  const startMs = Date.now();
  const key = `${ep.url}${ep.path}`;

  try {
    const options: RequestInit =
      ep.method === "POST"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ep.body ?? {}),
          }
        : {};

    const res = await fetchWithX402(`${ep.url}${ep.path}`, options);
    const data = (await res.json()) as Record<string, unknown>;

    failureCounts.set(key, 0);

    return {
      endpoint: ep.path,
      product: ep.name,
      status: "success",
      costUsdc: ep.costUsdc,
      responsePeek: JSON.stringify(data).slice(0, 120),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const prev = failureCounts.get(key) ?? 0;
    failureCounts.set(key, prev + 1);

    const error = err instanceof Error ? err.message : String(err);
    return {
      endpoint: ep.path,
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
  return failureCounts.get(`${ep.url}${ep.path}`) ?? 0;
}
