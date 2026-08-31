/**
 * Spend ceilings for the weekly external probe.
 *
 * Three ceilings (§2 of the worksheet):
 *   1 call  $0.20 — anything quoted above this is recorded and skipped, unpaid
 *   1 run   $2.00
 *   1 week  $4.00 — twice the run cap, so a second run in the same week
 *                   (a manual retry) is not rejected wholesale
 *
 * The arithmetic is not re-implemented: `checkBudget` from the ERC-8004 gas
 * budget already expresses "per-item cap + running total cap" and is reused for
 * both the run and the week, so there is one place where a ceiling can be wrong.
 *
 * Weekly spend is persisted, because Railway's local disk is reset on redeploy:
 * Upstash when configured, an append-only local JSONL otherwise. A weekly total
 * that resets to zero on deploy is not a ceiling.
 */
import * as fs from "fs";
import * as path from "path";
import { checkBudget } from "../erc8004/gas-budget";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";

/** 1 コール上限 (USD)。 */
export const PER_CALL_CAP_USD = Number(process.env.PROBE_PER_CALL_CAP_USD ?? "0.20");
/** 1 回(1 sweep)上限 (USD)。 */
export const PER_RUN_CAP_USD = Number(process.env.PROBE_PER_RUN_CAP_USD ?? "2.00");
/** 週上限 (USD)。 */
export const WEEKLY_CAP_USD = Number(process.env.PROBE_WEEKLY_CAP_USD ?? "4.00");

/** Per-call ceiling in micro-USDC, for the payment-selection policy. */
export function perCallMicroUsdc(cap = PER_CALL_CAP_USD): bigint {
  return BigInt(Math.floor(cap * 1e6));
}

/** ISO-8601 week key, e.g. "2026-W36". Weeks start Monday, matching the cron. */
export function isoWeekKey(d: Date = new Date()): string {
  // Shift to Thursday of the same ISO week: the year of that Thursday is the
  // ISO year, which is what makes week 1 unambiguous at a year boundary.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() === 0 ? 7 : t.getUTCDay(); // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export interface BudgetVerdict {
  allowed: boolean;
  reason?: string;
  /** Which ceiling refused. */
  ceiling?: "per_call" | "per_run" | "per_week";
}

/**
 * Decide whether one quoted call may be paid. Pure — the caller owns the totals.
 *
 * @param priceUsd   quoted price of this call, in USDC
 * @param runSpent   already spent in this sweep
 * @param weekSpent  already spent this ISO week
 */
export function allowsCall(
  priceUsd: number,
  runSpent: number,
  weekSpent: number,
  caps: { perCall?: number; perRun?: number; perWeek?: number } = {}
): BudgetVerdict {
  const perCall = caps.perCall ?? PER_CALL_CAP_USD;
  const perRun = caps.perRun ?? PER_RUN_CAP_USD;
  const perWeek = caps.perWeek ?? WEEKLY_CAP_USD;

  const run = checkBudget(priceUsd, runSpent, perCall, perRun);
  if (!run.allowed) {
    // checkBudget rejects the per-item cap first, so a refusal at the per-call
    // ceiling is distinguishable from one at the run total.
    const ceiling = priceUsd > perCall ? "per_call" : "per_run";
    return { allowed: false, ceiling, reason: run.reason };
  }
  const week = checkBudget(priceUsd, weekSpent, perCall, perWeek);
  if (!week.allowed) return { allowed: false, ceiling: "per_week", reason: week.reason };

  return { allowed: true };
}

// ── weekly spend persistence ────────────────────────────────────────────────

const DIR = () => path.join(process.cwd(), "data", "probe");
const SPEND_FILE = () => path.join(DIR(), "weekly-spend.jsonl");

function weekRedisKey(week: string): string {
  return `probe_spend:${week}`;
}

/** Read what this ISO week has already cost. Never throws; unknown reads as 0. */
export async function readWeekSpend(week = isoWeekKey()): Promise<number> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string | null>(["GET", weekRedisKey(week)]);
      const n = Number(raw ?? 0);
      if (Number.isFinite(n)) return n;
    } catch (err) {
      console.warn(`[PROBE] weekly spend read failed: ${String(err)}`);
    }
  }
  try {
    return fs
      .readFileSync(SPEND_FILE(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { week: string; usdc: number })
      .filter((e) => e.week === week)
      .reduce((sum, e) => sum + (Number.isFinite(e.usdc) ? e.usdc : 0), 0);
  } catch {
    return 0;
  }
}

/** Append one spend entry for the current ISO week. Append-only; never rewritten. */
export async function recordWeekSpend(
  usdc: number,
  meta: { target: string; path: string },
  week = isoWeekKey()
): Promise<void> {
  if (!Number.isFinite(usdc) || usdc <= 0) return;

  if (upstashConfigured()) {
    try {
      await upstashCommand(["INCRBYFLOAT", weekRedisKey(week), String(usdc)]);
      // Keep a few weeks of history, then let it go.
      await upstashCommand(["EXPIRE", weekRedisKey(week), 60 * 60 * 24 * 60]);
    } catch (err) {
      console.warn(`[PROBE] weekly spend write failed: ${String(err)}`);
    }
  }
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(
      SPEND_FILE(),
      JSON.stringify({ at: new Date().toISOString(), week, usdc, ...meta }) + "\n",
      "utf-8"
    );
  } catch (err) {
    console.warn(`[PROBE] weekly spend local write failed: ${String(err)}`);
  }
}
