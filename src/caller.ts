import { decodePaymentResponseHeader } from "@x402/fetch";
import { fetchWithPayment } from "./x402";
import { getRequestBody } from "./bodies";
import { detectDegraded } from "./stub-detector";
import type { EndpointConfig } from "./config";
import type { EndpointResult } from "./types";

const failureCounts = new Map<string, number>();

/**
 * How much of a failed response body to keep in the error message.
 *
 * This was 300, which truncated exactly the part that mattered. A CDP
 * facilitator settle failure arrives as
 * `{"x402Version":2,"error":"facilitator settle error: HTTP 402 ... for
 * https://api.cdp.coinbase.com/...: {"correlationId":"...","errorLink":"...",
 * "errorMessage":"A val` — the nested envelope alone spends the budget, so the
 * `errorMessage` naming the actual cause was cut off every time. 2000 keeps the
 * whole envelope while still bounding an HTML error page.
 */
export const ERROR_BODY_MAX_CHARS = 2000;

/** Bound a response body for logging, saying so when it was cut. */
export function clipBody(text: string, max = ERROR_BODY_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length} 文字中 ${max} 文字)`;
}

/**
 * Whether a settled network string corresponds to the config's coarse `chain`
 * label. Settlement reports CAIP-2 (`eip155:8453`, `solana:5eyk…`) or the v1
 * aliases (`base`, `solana`), so this compares families rather than strings.
 */
export function networkMatchesChain(network: string, chain: string): boolean {
  const n = network.toLowerCase();
  switch (chain) {
    case "base":
      return n === "base" || n.startsWith("eip155:8453");
    case "solana":
      return n === "solana" || n.startsWith("solana:");
    case "polygon":
      return n === "polygon" || n.startsWith("eip155:137");
    case "bnb":
      return n === "bnb" || n.startsWith("eip155:56");
    default:
      return false;
  }
}

export async function callEndpoint(ep: EndpointConfig): Promise<EndpointResult> {
  const startMs = Date.now();

  try {
    const body = ep.method === "POST" ? getRequestBody(ep.id) : undefined;
    const options: RequestInit =
      body !== undefined
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {};

    console.log(`[CALLER:${ep.chain}] ${ep.method} ${ep.url}`);
    const res = await fetchWithPayment(ep.url, options);

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`HTTP ${res.status}: ${clipBody(text)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Extract tx hash from payment response header
    const paymentResponseHeader =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    let txHash: string | undefined;
    let settledNetwork: string | undefined;
    if (paymentResponseHeader) {
      try {
        const decoded = decodePaymentResponseHeader(paymentResponseHeader);
        txHash = decoded.transaction;
        settledNetwork = decoded.network ? String(decoded.network) : undefined;
      } catch {
        // header present but unparseable — non-fatal
      }
    }
    // The config's `chain` is what we expect to pay on; this is what we did pay
    // on. A mismatch is silent otherwise, and a wrong assumption about which
    // chain a call settles on sends the next incident down the wrong path.
    if (settledNetwork && !networkMatchesChain(settledNetwork, ep.chain)) {
      console.warn(
        `[CALLER:${ep.chain}] ⚠️  ${ep.name} — 決済先が設定と不一致: ` +
          `設定 ${ep.chain} / 実際 ${settledNetwork}`
      );
    }

    failureCounts.set(ep.id, 0);

    const detection = detectDegraded(data);
    if (detection.degraded) {
      console.warn(`[CALLER:${ep.chain}] ~ ${ep.name} — degraded: ${detection.reason}`);
      return {
        endpoint: ep.url,
        product: ep.name,
        status: "degraded",
        costUsdc: ep.cost,
        responsePeek: JSON.stringify(data).slice(0, 120),
        txHash,
        settledNetwork,
        degradedReason: detection.reason,
        durationMs: Date.now() - startMs,
        ...(ep.captureFullData ? { fullData: data } : {}),
      };
    }

    return {
      endpoint: ep.url,
      product: ep.name,
      status: "success",
      costUsdc: ep.cost,
      responsePeek: JSON.stringify(data).slice(0, 120),
      txHash,
      settledNetwork,
      durationMs: Date.now() - startMs,
      ...(ep.captureFullData ? { fullData: data } : {}),
    };
  } catch (err) {
    const prev = failureCounts.get(ep.id) ?? 0;
    failureCounts.set(ep.id, prev + 1);

    const error = err instanceof Error ? err.message : String(err);
    console.error(`[CALLER:${ep.chain}] ✗ ${ep.name} — ${error}`);
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
