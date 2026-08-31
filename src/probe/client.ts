/**
 * Payment client for the external probe.
 *
 * Separate from the daily agent client on purpose:
 *   - it signs with a separate wallet (§5: probe funds are not production funds)
 *   - its per-call policy ceiling is $0.20, not the agent's $3.00
 * Everything else is the existing machinery — wrapFetchWithPayment does the
 * transport, the 402 parsing and the signing. No 402 parser is written here;
 * hand-rolling one is how the JIN diagnosis went wrong (v2 carries the challenge
 * in the PAYMENT-REQUIRED header, v1 in the body).
 *
 * The three ceilings are enforced inside `registerPolicy`, which runs during
 * requirement selection — structurally before anything is signed. A call the
 * budget refuses leaves no requirement to select, so the library aborts instead
 * of paying.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createCircleEvmSigner } from "../circle/evm-signer";
import { priceOf } from "../payment-guard";
import { allowsCall, PER_CALL_CAP_USD, PER_RUN_CAP_USD, WEEKLY_CAP_USD } from "./budget";

/** Networks the probe wallet can settle on (v2 CAIP-2 and the v1 alias). */
export const PROBE_NETWORKS = ["eip155:8453", "base"];

export interface ProbeSpend {
  /** USDC spent so far in this sweep. */
  run: number;
  /** USDC spent so far this ISO week (loaded from the persistent store). */
  week: number;
}

export interface ObservedChallenge {
  x402Version: number;
  /** Every network the seller offered. */
  offeredNetworks: string[];
  /** Cheapest price on a network this wallet can pay, in USDC. */
  quotedUsdc?: number;
  accepts: PaymentRequirements[];
}

export interface ProbeClient {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The 402 seen for the most recent request, cleared before each call. */
  takeChallenge: () => ObservedChallenge | undefined;
  walletAddress: string;
}

function networkOf(r: PaymentRequirements): string {
  return String((r as { network?: unknown }).network ?? "");
}

/** Cheapest requirement we could actually pay, and what was on offer. */
export function observe(paymentRequired: PaymentRequired): ObservedChallenge {
  const accepts = paymentRequired.accepts ?? [];
  const payable = accepts
    .filter((r) => PROBE_NETWORKS.includes(networkOf(r)))
    .map((r) => priceOf(r))
    .filter((p): p is number => p !== undefined);
  return {
    x402Version: paymentRequired.x402Version,
    offeredNetworks: [...new Set(accepts.map(networkOf))],
    quotedUsdc: payable.length > 0 ? Math.min(...payable) : undefined,
    accepts,
  };
}

/**
 * Build the probe's paying fetch, or null when no probe wallet is configured.
 *
 * Returning null rather than throwing keeps run 0 (which pays nothing) usable
 * before the wallet exists.
 */
export function buildProbeClient(spend: ProbeSpend): ProbeClient | null {
  const walletId = process.env.CIRCLE_PROBE_WALLET_ID;
  const walletAddress = process.env.CIRCLE_PROBE_WALLET_ADDRESS;
  if (!walletId || !walletAddress) return null;

  // Circle DCW holds the key; the agent holds a wallet id. No raw key in env.
  const signer = createCircleEvmSigner(walletId, walletAddress as `0x${string}`, "live");
  const scheme = new ExactEvmScheme(signer);

  const base = new x402Client()
    .register("eip155:8453", scheme)
    .registerV1("base", scheme)
    .registerPolicy((_version: number, reqs: PaymentRequirements[]) =>
      reqs.filter((r) => {
        const price = priceOf(r);
        if (price === undefined) return false; // 読めない金額は払わない
        return allowsCall(price, spend.run, spend.week).allowed;
      })
    );

  let last: ObservedChallenge | undefined;
  const http = new x402HTTPClient(base).onPaymentRequired(async (ctx) => {
    last = observe(ctx.paymentRequired);
    // No headers returned → proceed to the normal payment path.
  });

  const paying = wrapFetchWithPayment(fetch, http);
  return {
    fetch: paying,
    takeChallenge: () => {
      const c = last;
      last = undefined;
      return c;
    },
    walletAddress,
  };
}

/** One-line description of the ceilings, for the run header. */
export function capsSummary(): string {
  return `per-call $${PER_CALL_CAP_USD.toFixed(2)} / run $${PER_RUN_CAP_USD.toFixed(
    2
  )} / week $${WEEKLY_CAP_USD.toFixed(2)}`;
}
