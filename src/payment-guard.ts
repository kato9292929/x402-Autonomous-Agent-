/**
 * Self-payment guard for the buyer leg (T8–T9).
 *
 * Everything here runs *before* a payment is signed. The transport, the 402
 * parsing and the signing itself stay inside @x402/fetch — deliberately, because
 * hand-rolling the 402 loop is how the JIN diagnosis went wrong: x402 v2 carries
 * the challenge in the PAYMENT-REQUIRED header and v1 in the body, and a
 * hand-written parser sees only one of them.
 *
 * Of the three delegation problems, only the session cap is new here:
 *   - key custody   → Circle DCW already holds the key; the agent has a wallet id
 *   - per-call cap  → withinMicroUsdcCap via registerPolicy, applied during
 *                     requirement selection, i.e. structurally before signing
 *   - human sign-off → the existing World ID /approve flow
 *   - session cap   → new (this file)
 */
import type { PaymentRequirements } from "@x402/core/types";

/** Base Sepolia. The testnet demo must never settle anywhere else. */
export const TESTNET_NETWORK = "eip155:84532";
export const EXACT_SCHEME = "exact";

export type DeclineReason =
  | "per_call_cap"
  | "session_cap"
  | "human_rejected"
  | "halt_network";

export class PaymentDeclined extends Error {
  constructor(public readonly reason: DeclineReason, message?: string) {
    super(message ?? `payment declined: ${reason}`);
    this.name = "PaymentDeclined";
  }
}

export interface SessionCap {
  /** Cumulative ceiling for this session, in USDC. */
  limit: number;
  /** Spent so far, in USDC. */
  spent: number;
}

export function withinSessionCap(cap: SessionCap, price: number): boolean {
  if (!Number.isFinite(price) || price < 0) return false;
  return cap.spent + price <= cap.limit;
}

/** USDC amount of a requirement, from whichever field the leg carries it in. */
export function priceOf(req: PaymentRequirements): number | undefined {
  const raw =
    (req as { amount?: string }).amount ??
    (req as { maxAmountRequired?: string }).maxAmountRequired;
  if (raw === undefined || raw === null) return undefined;
  try {
    // USDC is 6-decimal on both Base and Solana.
    return Number(BigInt(raw)) / 1e6;
  } catch {
    return undefined;
  }
}

export interface GuardDeps {
  session: SessionCap;
  /** Networks this guard will settle on. Anything else halts. */
  allowedNetworks: string[];
  /** True the first time this payee is seen; drives the approval prompt. */
  isFirstSeen: (payTo: string) => boolean;
  markSeen: (payTo: string) => void;
  /** The existing World ID approval flow. Resolves false when declined. */
  requestApproval: (
    req: PaymentRequirements,
    reason: "first_seen"
  ) => Promise<boolean>;
  /** Append-only record. Called for declines as well as approvals. */
  audit: (entry: Record<string, unknown>) => void;
}

/**
 * Decide whether a payment may proceed.
 *
 * Throws PaymentDeclined to stop the payment; the library then neither signs nor
 * retries. Returns the requirements unchanged when it may go ahead.
 *
 * Note the per-call cap is not re-checked here: registerPolicy has already
 * filtered the requirements before selection, so anything reaching this point is
 * within it. Re-implementing it would give two ceilings that could disagree.
 */
export async function guardPayment(
  req: PaymentRequirements,
  deps: GuardDeps
): Promise<PaymentRequirements> {
  const network = (req as { network?: string }).network ?? "";
  const scheme = (req as { scheme?: string }).scheme ?? "";
  const payTo = (req as { payTo?: string }).payTo ?? "";
  const price = priceOf(req);

  // 1. Network. A mainnet offer during the testnet demo means something is
  //    wrong upstream, so stop the session rather than pay real money.
  if (!deps.allowedNetworks.includes(network) || scheme !== EXACT_SCHEME) {
    deps.audit({ kind: "halt", reason: "halt_network", network, scheme, payTo });
    throw new PaymentDeclined(
      "halt_network",
      `refusing ${scheme || "?"} on ${network || "?"} — allowed: ${deps.allowedNetworks.join(", ")}`
    );
  }

  // An unreadable price cannot be checked against the cap, so it is not paid.
  if (price === undefined) {
    deps.audit({ kind: "decline", reason: "session_cap", note: "unreadable price", payTo });
    throw new PaymentDeclined("session_cap", "payment amount could not be read");
  }

  // 2. Session ceiling.
  if (!withinSessionCap(deps.session, price)) {
    deps.audit({
      kind: "decline",
      reason: "session_cap",
      price,
      spent: deps.session.spent,
      limit: deps.session.limit,
      payTo,
    });
    throw new PaymentDeclined(
      "session_cap",
      `session cap: spent ${deps.session.spent} + ${price} > ${deps.session.limit} USDC`
    );
  }

  // 3. Human sign-off on the first payment to a payee.
  if (deps.isFirstSeen(payTo)) {
    const approved = await deps.requestApproval(req, "first_seen");
    if (!approved) {
      deps.audit({ kind: "decline", reason: "human_rejected", price, payTo });
      throw new PaymentDeclined("human_rejected", `not approved for ${payTo}`);
    }
    deps.markSeen(payTo);
  }

  // Counted at approval rather than on settlement: the ceiling should bound what
  // the agent commits to, and a retry after a lost response must not double-spend
  // the budget.
  deps.session.spent += price;
  deps.audit({ kind: "approved", price, network, payTo, spent: deps.session.spent });
  return req;
}
