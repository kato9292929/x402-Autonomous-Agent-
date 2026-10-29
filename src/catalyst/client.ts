/**
 * Payment client for the weekly per-call sweeps (Solana mainnet, exact SVM).
 * Shared by every paycall surface (catalyst, EDINET) — the surface only changes
 * the price / mint / cap, not how the payment is made.
 *
 * This does NOT hand-build a USDC transfer. x402's exact SVM scheme constructs
 * the specific transaction the facilitator settles; a raw SPL transfer would not
 * satisfy it, and hand-rolling the 402 loop is the JIN bug's shape. So the sweep
 * signs through the same `ExactSvmScheme` + `wrapFetchWithPayment` the daily run
 * already uses for the osd Solana endpoints, backed by the same Circle DCW
 * signer — the key stays in Circle, the deployment holds only a wallet id.
 *
 * The safety valve lives in the selection policy, so it runs BEFORE signing:
 * a requirement is paid only when it is Solana, denominated in the surface's USDC
 * mint, and priced at exactly the surface's price. Anything else is filtered out,
 * the library finds nothing to select, and the payment aborts unsigned. (Note the
 * runbook's "payTo == our address" check was backwards — payTo is the seller we
 * pay, so it is not verified here; the amount, asset and network are.)
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import { registerExactSvmScheme, ExactSvmScheme } from "@x402/svm/exact/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { getCircleSolanaSignerFromEnv, resolveSolanaBackend } from "../circle/solana-signer";
import { createKeyPairSignerFromBytes, type TransactionPartialSigner } from "@solana/kit";
import { base58 } from "@scure/base";
import { allowsCall } from "../probe/budget";
import { CATALYST_SURFACE, type PaycallSurface } from "../paycall/surface";

// Catalyst-bound constants, kept so existing catalyst callers/tests read the
// same names. New code should read the surface directly.
export const PRICE_UNITS = CATALYST_SURFACE.priceUnits;
export const USDC_MINT = CATALYST_SURFACE.usdcMint;
export const PRICE_USDC = CATALYST_SURFACE.priceUsd;
export const WEEKLY_CAP_USD = CATALYST_SURFACE.weeklyCapUsd;

export interface CatalystSpend {
  /** USDC spent so far in this sweep. */
  run: number;
  /** USDC spent so far this ISO week (from the persistent store). */
  week: number;
}

export interface ObservedChallenge {
  x402Version: number;
  offeredNetworks: string[];
  /** Whether at least one requirement matched all the safety checks. */
  payable: boolean;
  /** Amounts quoted on Solana requirements, in base units, for the record. */
  quotedUnits: string[];
  accepts: PaymentRequirements[];
}

export interface CatalystClient {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The 402 seen for the most recent request, cleared before each call. */
  takeChallenge: () => ObservedChallenge | undefined;
  walletAddress: string;
}

function networkOf(r: PaymentRequirements): string {
  return String((r as { network?: unknown }).network ?? "");
}
function assetOf(r: PaymentRequirements): string {
  return String((r as { asset?: unknown }).asset ?? "");
}
function isSolana(network: string): boolean {
  return network === "solana" || network.startsWith("solana:");
}

/** Amount in base units, from whichever field the leg carries it in. */
export function amountUnits(r: PaymentRequirements): bigint | undefined {
  const raw =
    (r as { amount?: string }).amount ?? (r as { maxAmountRequired?: string }).maxAmountRequired;
  if (raw === undefined || raw === null) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

/**
 * The safety valve: pay only Solana, surface-USDC-mint, exactly-price requirements.
 * Exact (==), not a ceiling — a call has one price and anything else means the
 * offer is not the one we agreed to.
 */
export function isExpectedRequirement(
  r: PaymentRequirements,
  surface: PaycallSurface = CATALYST_SURFACE
): boolean {
  return (
    isSolana(networkOf(r)) &&
    assetOf(r) === surface.usdcMint &&
    amountUnits(r) === surface.priceUnits &&
    String((r as { scheme?: unknown }).scheme ?? "") === "exact"
  );
}

export function observe(
  paymentRequired: PaymentRequired,
  surface: PaycallSurface = CATALYST_SURFACE
): ObservedChallenge {
  const accepts = paymentRequired.accepts ?? [];
  return {
    x402Version: paymentRequired.x402Version,
    offeredNetworks: [...new Set(accepts.map(networkOf))],
    payable: accepts.some((r) => isExpectedRequirement(r, surface)),
    quotedUnits: accepts
      .filter((r) => isSolana(networkOf(r)))
      .map((r) => amountUnits(r))
      .filter((u): u is bigint => u !== undefined)
      .map((u) => u.toString()),
    accepts,
  };
}

async function solanaSigner(): Promise<TransactionPartialSigner | undefined> {
  const backend = resolveSolanaBackend();
  if (backend === "circle") {
    return getCircleSolanaSignerFromEnv()?.signer;
  }
  if (backend === "privatekey") {
    const keyBytes = base58.decode(process.env.SOLANA_PRIVATE_KEY as string);
    return createKeyPairSignerFromBytes(keyBytes);
  }
  return undefined;
}

/**
 * Build the sweep's paying fetch for a surface, or null when no Solana signer is
 * configured. Uses the same wallet as the daily run (no new key, no new wallet)
 * but its own client so the exact-price policy is scoped to this surface and does
 * not tighten the daily run's other Solana payments.
 */
export async function buildPaycallClient(
  surface: PaycallSurface,
  spend: CatalystSpend
): Promise<CatalystClient | null> {
  const signer = await solanaSigner();
  if (!signer) return null;

  const client = new x402Client().registerPolicy(
    (_version: number, reqs: PaymentRequirements[]) =>
      reqs.filter(
        (r) =>
          isExpectedRequirement(r, surface) &&
          allowsCall(surface.priceUsd, spend.run, spend.week, {
            perRun: surface.weeklyCapUsd,
            perWeek: surface.weeklyCapUsd,
          }).allowed
      )
  );

  // Register the SVM scheme, then override "solana:*" with a dedicated RPC when
  // one is set — the public endpoint rate-limits server traffic (the JIN lesson).
  registerExactSvmScheme(client, { signer });
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (rpcUrl) {
    client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl }));
  } else {
    console.warn(
      `[${surface.id.toUpperCase()}] SOLANA_RPC_URL not set — sweeping ~200 items through the ` +
        "public api.mainnet-beta.solana.com endpoint will likely rate-limit"
    );
  }

  let last: ObservedChallenge | undefined;
  const http = new x402HTTPClient(client).onPaymentRequired(async (ctx) => {
    last = observe(ctx.paymentRequired, surface);
    // No headers returned → proceed to the normal payment path.
  });

  return {
    fetch: wrapFetchWithPayment(fetch, http),
    takeChallenge: () => {
      const c = last;
      last = undefined;
      return c;
    },
    walletAddress: signer.address,
  };
}

/** Catalyst-bound builder, kept for existing callers. */
export function buildCatalystClient(spend: CatalystSpend): Promise<CatalystClient | null> {
  return buildPaycallClient(CATALYST_SURFACE, spend);
}

export function priceSummary(surface: PaycallSurface = CATALYST_SURFACE): string {
  return `${surface.priceUsd} USDC (${surface.priceUnits} units) / mint ${surface.usdcMint.slice(0, 6)}…`;
}
