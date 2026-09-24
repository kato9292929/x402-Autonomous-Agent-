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
    case "arc":
      // Arc mainnet is chain id 5042. It is EVM, so a settlement on it reports
      // an eip155 network like any other — the label is what tells them apart.
      return n === "arc" || n.startsWith("eip155:5042");
    case "polygon":
      return n === "polygon" || n.startsWith("eip155:137");
    case "bnb":
      return n === "bnb" || n.startsWith("eip155:56");
    default:
      return false;
  }
}

/**
 * What a failing x402 response tells us about WHERE it failed.
 *
 * A bare `HTTP 402: {}` is ambiguous and cost us days: in x402 v2 the challenge
 * travels in the PAYMENT-REQUIRED header and the body is empty, so an empty
 * body after we already signed can mean either of two very different things:
 *
 *   - a FRESH challenge (PAYMENT-REQUIRED present) — the seller did not accept
 *     the payment we sent: verify rejected it, or our header never registered.
 *     The seller is asking again, as if unpaid.
 *   - settlement failed (no PAYMENT-REQUIRED) — @x402/next returns the
 *     facilitator's own error verbatim in the body when settle fails, so an
 *     empty body here means the failure was not a settle error either.
 *
 * Reading the headers separates them without another round trip. `accepts` is
 * decoded far enough to name the networks offered, because "which chain did the
 * seller actually offer" is the first question in every one of these.
 */
export function describeX402Failure(res: Response): string {
  if (res.status !== 402) return "";
  const challenge = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("X-PAYMENT-REQUIRED");
  const settle = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  const parts: string[] = [];

  if (challenge) {
    parts.push(`再チャレンジ(支払い未受理) offered=${decodeOfferedNetworks(challenge)}`);
  } else {
    parts.push("再チャレンジなし(支払いは受理されたが 200 に至らず)");
  }
  if (settle) parts.push(`settle=${clipBody(decodeHeaderJson(settle), 400)}`);
  return ` — ${parts.join(" / ")}`;
}

/** Networks named by a base64 PAYMENT-REQUIRED header, or why it could not be read. */
function decodeOfferedNetworks(header: string): string {
  try {
    const parsed = JSON.parse(decodeHeaderJson(header)) as {
      accepts?: { network?: unknown }[];
    };
    const nets = (parsed.accepts ?? []).map((a) => String(a.network ?? "?"));
    return nets.length > 0 ? nets.join(",") : "(accepts 空)";
  } catch {
    return "(復号不能)";
  }
}

/** base64 header → JSON text, falling back to the raw value when it is not base64. */
function decodeHeaderJson(header: string): string {
  try {
    return Buffer.from(header, "base64").toString("utf8");
  } catch {
    return header;
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
      throw new Error(`HTTP ${res.status}: ${clipBody(text)}${describeX402Failure(res)}`);
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
