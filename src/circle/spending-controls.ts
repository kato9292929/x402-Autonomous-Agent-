import * as fs from "fs";
import * as path from "path";
import type { PaymentRequirements } from "@x402/core/types";

/**
 * Client-side spending controls for the x402 payment flow.
 *
 * IMPORTANT — why this is enforced in the agent, not only in Circle:
 * x402's "exact" scheme pays via an off-chain EIP-3009 authorization
 * (`signTypedData`). Circle's policy engine governs *on-chain transactions*
 * (`createTransaction`); it does not gate `signTypedData`/`signMessage`. So to
 * actually stop the agent from over-spending we enforce three limits here,
 * inside the x402 client's payment policy, BEFORE any signature is requested:
 *
 *   1. per-transaction limit  (e.g. $5)
 *   2. daily limit            (e.g. $20, rolling per UTC day)
 *   3. allowlist              (only pay the configured recipient addresses)
 *
 * The equivalent Circle-native policy (for on-chain `createTransaction` flows)
 * is documented in README and applied via `npm run circle:setup`.
 *
 * Amounts are tracked in atomic USDC units (6 decimals) for precision.
 */

const USDC_DECIMALS = 6;
const ATOMIC_PER_USDC = 10 ** USDC_DECIMALS;

export function usdToAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * ATOMIC_PER_USDC));
}

function atomicToUsd(atomic: bigint): string {
  return (Number(atomic) / ATOMIC_PER_USDC).toFixed(2);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface SpendState {
  date: string;
  spentAtomic: string; // bigint serialized as string
}

export interface SpendingControlsConfig {
  perTxLimitUsd: number;
  dailyLimitUsd: number;
  /** Lowercased recipient addresses the agent is allowed to pay. Empty = allow all. */
  allowlist: string[];
  /** Where to persist the rolling daily total. */
  stateFile?: string;
}

export class SpendingControls {
  readonly perTxLimitAtomic: bigint;
  readonly dailyLimitAtomic: bigint;
  private readonly allowlist: Set<string>;
  private readonly stateFile: string;

  constructor(config: SpendingControlsConfig) {
    this.perTxLimitAtomic = usdToAtomic(config.perTxLimitUsd);
    this.dailyLimitAtomic = usdToAtomic(config.dailyLimitUsd);
    this.allowlist = new Set(config.allowlist.map((a) => a.toLowerCase()));
    this.stateFile =
      config.stateFile ??
      path.join(process.cwd(), "data", "circle-spend-state.json");

    if (this.allowlist.size === 0) {
      console.warn(
        "[SPENDING] No allowlist configured (CIRCLE_ALLOWLIST empty) — " +
          "all payment recipients will be accepted. Set CIRCLE_ALLOWLIST to restrict."
      );
    }
  }

  /** Build from environment variables, with sane testnet defaults. */
  static fromEnv(): SpendingControls {
    const perTx = Number(process.env.CIRCLE_PER_TX_LIMIT_USD ?? "5");
    const daily = Number(process.env.CIRCLE_DAILY_LIMIT_USD ?? "20");
    const allowlist = (process.env.CIRCLE_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return new SpendingControls({
      perTxLimitUsd: perTx,
      dailyLimitUsd: daily,
      allowlist,
    });
  }

  private readState(): SpendState {
    try {
      const raw = fs.readFileSync(this.stateFile, "utf-8");
      const parsed = JSON.parse(raw) as SpendState;
      if (parsed.date === todayUtc()) return parsed;
    } catch {
      // missing / unreadable / stale — fall through to a fresh day
    }
    return { date: todayUtc(), spentAtomic: "0" };
  }

  private writeState(state: SpendState): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf-8");
  }

  spentTodayAtomic(): bigint {
    return BigInt(this.readState().spentAtomic);
  }

  remainingTodayAtomic(): bigint {
    const remaining = this.dailyLimitAtomic - this.spentTodayAtomic();
    return remaining > 0n ? remaining : 0n;
  }

  private isAllowed(payTo: string): boolean {
    if (this.allowlist.size === 0) return true;
    return this.allowlist.has(payTo.toLowerCase());
  }

  /**
   * x402 PaymentPolicy: returns only the requirements that satisfy every
   * limit. Returning `[]` causes the x402 client to reject the payment
   * (no acceptable option) — i.e. the agent stops rather than over-spending.
   */
  policy = (
    _version: number,
    requirements: PaymentRequirements[]
  ): PaymentRequirements[] => {
    const remaining = this.remainingTodayAtomic();

    return requirements.filter((r) => {
      let amount: bigint;
      try {
        amount = BigInt(r.amount);
      } catch {
        return false;
      }

      if (amount > this.perTxLimitAtomic) {
        console.warn(
          `[SPENDING] Rejected: $${atomicToUsd(amount)} exceeds per-tx limit ` +
            `$${atomicToUsd(this.perTxLimitAtomic)} (payTo=${r.payTo})`
        );
        return false;
      }

      if (amount > remaining) {
        console.warn(
          `[SPENDING] Rejected: $${atomicToUsd(amount)} would exceed remaining ` +
            `daily budget $${atomicToUsd(remaining)} (limit $${atomicToUsd(
              this.dailyLimitAtomic
            )})`
        );
        return false;
      }

      if (!this.isAllowed(r.payTo)) {
        console.warn(
          `[SPENDING] Rejected: recipient ${r.payTo} not in allowlist`
        );
        return false;
      }

      return true;
    });
  };

  /**
   * Record a confirmed payment against today's budget. Call this after a
   * successful x402 settlement. Idempotency is the caller's responsibility.
   */
  record(amountUsd: number): void {
    const state = this.readState();
    const updated = BigInt(state.spentAtomic) + usdToAtomic(amountUsd);
    this.writeState({ date: todayUtc(), spentAtomic: updated.toString() });
    console.log(
      `[SPENDING] Recorded $${amountUsd.toFixed(2)} — today total ` +
        `$${atomicToUsd(updated)} / $${atomicToUsd(this.dailyLimitAtomic)}`
    );
  }

  summary(): string {
    return (
      `per-tx=$${atomicToUsd(this.perTxLimitAtomic)}, ` +
      `daily=$${atomicToUsd(this.dailyLimitAtomic)} ` +
      `(spent today $${atomicToUsd(this.spentTodayAtomic())}), ` +
      `allowlist=${this.allowlist.size === 0 ? "(none)" : this.allowlist.size + " addr"}`
    );
  }
}
