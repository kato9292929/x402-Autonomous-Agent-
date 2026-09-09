/**
 * A "paycall surface" is one osd per-call product the agent sweeps weekly on
 * Solana: catalyst (/api/catalyst) and EDINET (/api/edinet). They differ only in
 * a handful of constants — the base path, the spend namespace, the autopilot
 * state key, and the (env-overridable) price/mint/cap — so the whole engine
 * (safety valve, Circle signing, the sweep loop, the autopilot state machine,
 * the reset) is shared and each surface is just this config. Duplicating the
 * safety valve or the signing would be the worst thing to copy: a fix to one
 * would silently not reach the other.
 */

/** Official Solana USDC mint. Shared default for every surface. */
export const OFFICIAL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface PaycallSurface {
  /** Short id — used in logs, the spend namespace, and the autopilot state key. */
  id: string;
  /** Per-item route prefix, e.g. "/api/catalyst" → items at "/api/catalyst/{item}". */
  listPath: string;
  /**
   * Where the free item roster comes from. Usually the same as listPath, but a
   * surface whose own base returns only a descriptor (EDINET) borrows another
   * surface's roster — EDINET pays /api/edinet/{code} for the same 197 codes
   * that /api/catalyst lists.
   */
  rosterPath: string;
  /** Exact per-call price, in base units (USDC is 6-decimal). */
  priceUnits: bigint;
  /** The same price in USDC. */
  priceUsd: number;
  /** USDC mint a requirement must quote. */
  usdcMint: string;
  /** Weekly spend ceiling, USD. */
  weeklyCapUsd: number;
  /** How many items run 0 pokes with an unpaid 402 read (they are homogeneous). */
  run0Sample: number;
}

/** Base URL shared by every surface (osd). */
export function osdBase(): string {
  return (process.env.OSD_API_BASE ?? "https://osd.x402jp.com").replace(/\/$/, "");
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build a surface, reading `${prefix}_PRICE_UNITS` etc. from env with shared
 * defaults (1000 units = 0.001 USDC, official mint, $0.50/week, sample 3).
 * `rosterPath` defaults to `listPath` and is overridable via `${prefix}_ROSTER_PATH`.
 */
export function loadSurface(
  id: string,
  listPath: string,
  prefix: string,
  rosterPath: string = listPath
): PaycallSurface {
  const priceUnits = BigInt(process.env[`${prefix}_PRICE_UNITS`] ?? "1000");
  return {
    id,
    listPath,
    rosterPath: process.env[`${prefix}_ROSTER_PATH`] ?? rosterPath,
    priceUnits,
    priceUsd: Number(priceUnits) / 1e6,
    usdcMint: process.env[`${prefix}_USDC_MINT`] ?? OFFICIAL_USDC_MINT,
    weeklyCapUsd: num(process.env[`${prefix}_WEEKLY_CAP_USD`], 0.5),
    run0Sample: Math.max(1, num(process.env[`${prefix}_RUN0_SAMPLE`], 3)),
  };
}

export const CATALYST_SURFACE: PaycallSurface = loadSurface("catalyst", "/api/catalyst", "CATALYST");
// EDINET pays /api/edinet/{code} but its own base returns only a descriptor, so
// it borrows catalyst's roster (the same 197 codes; /api/edinet accepts the
// 4-digit ticker as the code, no transform).
export const EDINET_SURFACE: PaycallSurface = loadSurface(
  "edinet",
  "/api/edinet",
  "EDINET",
  "/api/catalyst"
);
