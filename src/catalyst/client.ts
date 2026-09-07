/**
 * Payment client for the weekly catalyst sweep (Solana mainnet, exact SVM).
 *
 * This does NOT hand-build a USDC transfer. x402's exact SVM scheme constructs
 * the specific transaction the facilitator settles; a raw SPL transfer would not
 * satisfy it, and hand-rolling the 402 loop is the JIN bug's shape. So the sweep
 * signs through the same `ExactSvmScheme` + `wrapFetchWithPayment` the daily run
 * already uses for the osd Solana endpoints, backed by the same Circle DCW
 * signer — the key stays in Circle, the deployment holds only a wallet id.
 *
 * The safety valve lives in the selection policy, so it runs BEFORE signing:
 * a requirement is paid only when it is Solana, denominated in the official USDC
 * mint, and priced at exactly PRICE_UNITS. Anything else is filtered out, the
 * library finds nothing to select, and the payment aborts unsigned. (Note the
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

/** 0.0001 USDC = 100 base units (USDC is 6-decimal). */
export const PRICE_UNITS = BigInt(process.env.CATALYST_PRICE_UNITS ?? "100");
/** Official Solana USDC mint. Overridable only for a devnet smoke test. */
export const USDC_MINT =
  process.env.CATALYST_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** The exact price, in USDC, that a catalyst call must quote. */
export const PRICE_USDC = Number(PRICE_UNITS) / 1e6;
/**
 * Weekly spend ceiling for the sweep (SPEND_CAP_WEEK). Catalyst-specific — not
 * the probe's $4 — since a full ~200-ticker sweep costs about $0.02 and this
 * bounds a runaway loop, not routine spend.
 */
export const WEEKLY_CAP_USD = Number(process.env.CATALYST_WEEKLY_CAP_USD ?? "0.50");

export interface CatalystSpend {
  /** USDC spent so far in this sweep. */
  run: number;
  /** USDC spent so far this ISO week (from the persistent store). */
  week: number;
}

export interface ObservedChallenge {
  x402Version: number;
  offeredNetworks: string[];
  /** Whether at least one requirement matched all three safety checks. */
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
 * The safety valve: pay only Solana, official-USDC-mint, exactly-PRICE_UNITS
 * requirements. Exact (==), not a ceiling — a catalyst call has one price and
 * anything else means the offer is not the one we agreed to.
 */
export function isExpectedRequirement(r: PaymentRequirements): boolean {
  return (
    isSolana(networkOf(r)) &&
    assetOf(r) === USDC_MINT &&
    amountUnits(r) === PRICE_UNITS &&
    String((r as { scheme?: unknown }).scheme ?? "") === "exact"
  );
}

export function observe(paymentRequired: PaymentRequired): ObservedChallenge {
  const accepts = paymentRequired.accepts ?? [];
  return {
    x402Version: paymentRequired.x402Version,
    offeredNetworks: [...new Set(accepts.map(networkOf))],
    payable: accepts.some(isExpectedRequirement),
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
 * Build the sweep's paying fetch, or null when no Solana signer is configured.
 *
 * Uses the same wallet as the daily run (no new key, no new wallet) but its own
 * client so the exact-price policy is scoped to catalyst and does not tighten
 * the daily run's other Solana payments.
 */
export async function buildCatalystClient(spend: CatalystSpend): Promise<CatalystClient | null> {
  const signer = await solanaSigner();
  if (!signer) return null;

  const client = new x402Client().registerPolicy(
    (_version: number, reqs: PaymentRequirements[]) =>
      reqs.filter(
        (r) =>
          isExpectedRequirement(r) &&
          allowsCall(PRICE_USDC, spend.run, spend.week, {
            perRun: WEEKLY_CAP_USD,
            perWeek: WEEKLY_CAP_USD,
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
      "[CATALYST] SOLANA_RPC_URL not set — sweeping ~200 tickers through the public " +
        "api.mainnet-beta.solana.com endpoint will likely rate-limit"
    );
  }

  let last: ObservedChallenge | undefined;
  const http = new x402HTTPClient(client).onPaymentRequired(async (ctx) => {
    last = observe(ctx.paymentRequired);
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

export function priceSummary(): string {
  return `${PRICE_USDC} USDC (${PRICE_UNITS} units) / mint ${USDC_MINT.slice(0, 6)}…`;
}
