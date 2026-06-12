import { decodePaymentResponseHeader } from "@x402/fetch";
import { fetchWithPayment } from "./x402";
import { fetchWithSolanaPayment, type SolanaFetchConfig } from "./solana-payment";
import { getRequestBody } from "./bodies";
import type { EndpointConfig } from "./config";
import type { EndpointResult } from "./types";

const failureCounts = new Map<string, number>();

function getSolanaConfig(): SolanaFetchConfig {
  const walletId = process.env.CIRCLE_SOLANA_WALLET_ID;
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS;
  if (!walletId || !walletAddress) {
    throw new Error(
      "CIRCLE_SOLANA_WALLET_ID and SOLANA_WALLET_ADDRESS are required for Solana endpoints"
    );
  }
  return {
    walletId,
    walletAddress,
    maxMicroUsdc: BigInt(process.env.SOLANA_MAX_USDC_MICRO ?? "1000000"), // default $1.00
  };
}

export async function callEndpoint(ep: EndpointConfig): Promise<EndpointResult> {
  const startMs = Date.now();
  const chain = ep.chain;

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

    let res: Response;
    if (chain === "solana") {
      console.log(`[CALLER:${chain}] ${ep.method} ${ep.url}`);
      res = await fetchWithSolanaPayment(ep.url, options, getSolanaConfig());
    } else {
      console.log(`[CALLER:${chain}] ${ep.method} ${ep.url}`);
      res = await fetchWithPayment(ep.url, options);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // v2 uses PAYMENT-RESPONSE header; v1 used X-PAYMENT-RESPONSE
    const paymentResponseHeader =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    let txHash: string | undefined;
    if (paymentResponseHeader && chain !== "solana") {
      // For Base (EVM): decode structured payment response header
      try {
        const decoded = decodePaymentResponseHeader(paymentResponseHeader);
        txHash = decoded.transaction;
      } catch {
        // header present but unparseable — non-fatal
      }
    } else if (chain === "solana") {
      // For Solana: txHash is the Solana transaction signature embedded in proof header
      if (paymentResponseHeader) {
        try {
          const proof = JSON.parse(
            Buffer.from(paymentResponseHeader, "base64url").toString("utf-8")
          ) as { payload?: { signature?: string } };
          txHash = proof.payload?.signature;
        } catch {
          // non-fatal
        }
      }
    }

    failureCounts.set(ep.id, 0);

    return {
      endpoint: ep.url,
      product: ep.name,
      status: "success",
      costUsdc: ep.cost,
      responsePeek: JSON.stringify(data).slice(0, 120),
      txHash,
      durationMs: Date.now() - startMs,
      ...(ep.captureFullData ? { fullData: data } : {}),
    };
  } catch (err) {
    const prev = failureCounts.get(ep.id) ?? 0;
    failureCounts.set(ep.id, prev + 1);

    const error = err instanceof Error ? err.message : String(err);
    console.error(`[CALLER:${chain}] ✗ ${ep.name} — ${error}`);
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
