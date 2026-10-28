/**
 * The AA's internal buyer agents: Circle LIVE Solana wallets that pay the
 * internal sellers over x402 (`npm run mxe:setup` creates and funds them).
 *
 * Each payment passes two gates before anything is signed: the decided amount
 * must be exactly what the 402 asks (so a seller cannot re-price a trade the
 * MXE settled), and it must fit the existing spend ceilings — MXE spending is
 * charged to the same weekly ledger as the external probe, so the two together
 * stay inside the caps that already exist rather than adding a new allowance.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { base58 } from "@scure/base";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme, registerExactSvmScheme } from "@x402/svm/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import { circleSolanaSigner, type CircleSignTransactionClient } from "../poc/circle-solana-signer";
import { allowsCall, readWeekSpend, recordWeekSpend } from "../probe/budget";
import { withinMicroUsdcCap } from "../x402";
import { SOLANA_MAINNET, SOLANA_USDC_MINT } from "./seller";

/** Charged to the probe's weekly ledger: one set of ceilings for both. */
export const MXE_SPEND_NAMESPACE = "probe";

export interface AgentWallet {
  role: string;
  walletId: string;
  address: string;
}

/** `CIRCLE_MXE_<ROLE>_WALLET_ID` / `_WALLET_ADDRESS`, or undefined. */
export function agentWallet(role: "SELLER_A" | "SELLER_B" | "BUYER_A" | "BUYER_B", env = process.env): AgentWallet | undefined {
  const walletId = env[`CIRCLE_MXE_${role}_WALLET_ID`];
  const address = env[`CIRCLE_MXE_${role}_WALLET_ADDRESS`];
  return walletId && address ? { role, walletId, address } : undefined;
}

export interface Payment {
  ok: boolean;
  status?: number;
  tx?: string;
  paidMicro?: bigint;
  body?: unknown;
  error?: string;
}

/** Only an exact-USDC Solana leg for exactly `micro`, to exactly `payTo`. */
export function isExpectedLeg(r: PaymentRequirements, micro: bigint, payTo: string): boolean {
  const amount = (r as { amount?: string }).amount ?? (r as { maxAmountRequired?: string }).maxAmountRequired;
  return (
    r.scheme === "exact" &&
    r.network === SOLANA_MAINNET &&
    r.asset === SOLANA_USDC_MINT &&
    r.payTo === payTo &&
    amount === micro.toString() &&
    withinMicroUsdcCap(r, micro)
  );
}

/** Pay `url` from `buyer`, for exactly `micro` to `payTo`. Never throws. */
export async function payInternal(
  buyer: AgentWallet,
  url: string,
  micro: bigint,
  payTo: string,
  runSpentUsd: number
): Promise<Payment> {
  const usd = Number(micro) / 1e6;
  const week = await readWeekSpend(MXE_SPEND_NAMESPACE);
  const verdict = allowsCall(usd, runSpentUsd, week);
  if (!verdict.allowed) return { ok: false, error: `spend ceiling: ${verdict.reason}` };

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) return { ok: false, error: "CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET not set" };
  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const signerClient: CircleSignTransactionClient = {
    async signTransaction(input) {
      const r = await circle.signTransaction({ walletId: input.walletId, rawTransaction: input.rawTransaction });
      return { data: { signature: r.data?.signature } };
    },
  };
  const signer = circleSolanaSigner(signerClient, buyer.walletId, buyer.address, (s) => base58.decode(s));

  const client = new x402Client().registerPolicy((_v: number, reqs: PaymentRequirements[]) =>
    reqs.filter((r) => isExpectedLeg(r, micro, payTo))
  );
  registerExactSvmScheme(client, { signer });
  if (process.env.SOLANA_RPC_URL) {
    client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl: process.env.SOLANA_RPC_URL }));
  }

  try {
    const res = await wrapFetchWithPayment(fetch, client)(url);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    let tx: string | undefined;
    if (header) {
      try {
        tx = decodePaymentResponseHeader(header).transaction;
      } catch {
        /* the body below still says what happened */
      }
    }
    if (!res.ok || !tx) return { ok: false, status: res.status, body, error: `HTTP ${res.status}${tx ? "" : ", no settlement receipt"}` };
    await recordWeekSpend(MXE_SPEND_NAMESPACE, usd, { target: "mxe-internal", path: new URL(url).pathname });
    return { ok: true, status: res.status, tx, paidMicro: micro, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
