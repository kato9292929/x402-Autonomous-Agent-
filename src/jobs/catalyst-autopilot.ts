/**
 * Per-call self-onboarding ("autopilot"). Shared engine for every paycall
 * surface (catalyst, EDINET) — the surface only changes the state key, the spend
 * namespace (via the sweep) and the log tag.
 *
 * The point of the sweep is that the agent runs it — not that a human clicks
 * dry-run, then mainnet, then flips a flag. When {SURFACE}_AUTOPILOT=true the
 * agent drives that sequence itself at boot:
 *
 *   unstarted → run0 (unpaid; confirm the 402 is Solana / USDC / exact price)
 *             → pay ONE mainnet item (confirm a real Solscan tx)
 *             → live → schedule the weekly sweep.
 *
 * Idempotency is the whole safety story, because Railway redeploys on every
 * push and a boot-time paid step would otherwise re-pay (or re-loop) each time:
 *
 *   - State is persisted (Upstash; local file only as a dev fallback). Once
 *     "live", later boots skip straight to scheduling — no second smoke payment.
 *   - The paid smoke writes "smoking" BEFORE it pays. A boot that finds "smoking"
 *     HALTS rather than paying again (a payment may have settled), unless a clean
 *     no-funds smoke already rolled it back to "unstarted".
 *
 * All the guards from the sweep still apply underneath: the exact-requirement
 * safety valve and the weekly cap run before signing.
 */
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";
import { runSweep, type CatalystRunReport } from "./catalyst-sweep";
import { priceSummary } from "../catalyst/client";
import { CATALYST_SURFACE, EDINET_SURFACE, type PaycallSurface } from "../paycall/surface";
import * as fs from "fs";
import * as path from "path";

export type AutopilotStage = "unstarted" | "smoking" | "live";

export interface AutopilotState {
  stage: AutopilotStage;
  /** Item the smoke test paid. */
  ticker?: string;
  /** Settlement tx of the smoke payment (Solscan). */
  smokeTx?: string;
  at?: string;
}

const redisKey = (surface: PaycallSurface) => `${surface.id}_autopilot:state`;
const localFile = (surface: PaycallSurface) =>
  path.join(process.cwd(), "data", surface.id, "autopilot-state.json");
const tag = (surface: PaycallSurface) => `${surface.id.toUpperCase()}-AUTOPILOT`;

export async function readAutopilotState(
  surface: PaycallSurface = CATALYST_SURFACE
): Promise<AutopilotState> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string | null>(["GET", redisKey(surface)]);
      if (raw) return JSON.parse(raw) as AutopilotState;
      return { stage: "unstarted" };
    } catch (err) {
      console.warn(`[${tag(surface)}] state read failed: ${String(err)}`);
    }
  }
  try {
    return JSON.parse(fs.readFileSync(localFile(surface), "utf-8")) as AutopilotState;
  } catch {
    return { stage: "unstarted" };
  }
}

export async function writeAutopilotState(
  state: AutopilotState,
  surface: PaycallSurface = CATALYST_SURFACE
): Promise<void> {
  const value = JSON.stringify(state);
  if (upstashConfigured()) {
    try {
      await upstashCommand(["SET", redisKey(surface), value]);
    } catch (err) {
      console.warn(`[${tag(surface)}] state write failed: ${String(err)}`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(localFile(surface)), { recursive: true });
    fs.writeFileSync(localFile(surface), value, "utf-8");
  } catch (err) {
    console.warn(`[${tag(surface)}] local state write failed: ${String(err)}`);
  }
}

/**
 * Reset the marker to "unstarted" so the next boot re-onboards from scratch.
 * Used by `npm run <surface>:reset` to clear a stuck "smoking" after a human has
 * checked Solscan. Returns the state that was there before.
 */
export async function resetAutopilotState(
  surface: PaycallSurface = CATALYST_SURFACE
): Promise<AutopilotState> {
  const before = await readAutopilotState(surface);
  await writeAutopilotState({ stage: "unstarted", at: new Date().toISOString() }, surface);
  return before;
}

export interface AutopilotDeps {
  readState: () => Promise<AutopilotState>;
  writeState: (s: AutopilotState) => Promise<void>;
  /** Unpaid discovery. */
  runDiscovery: () => Promise<CatalystRunReport>;
  /** Paid smoke of exactly the given items. */
  runSmoke: (tickers: string[]) => Promise<CatalystRunReport>;
  /** Whether the durable store is available; the paid smoke needs it. */
  durable: boolean;
  /** Called once the agent is live, to schedule the weekly sweep. */
  onLive: () => void;
}

function defaultDeps(surface: PaycallSurface, onLive: () => void): AutopilotDeps {
  return {
    readState: () => readAutopilotState(surface),
    writeState: (s) => writeAutopilotState(s, surface),
    runDiscovery: () => runSweep(surface, { mode: "discovery" }),
    runSmoke: (tickers) => runSweep(surface, { mode: "sweep", tickers }),
    durable: upstashConfigured(),
    onLive,
  };
}

/**
 * Drive the onboarding one step per boot for a surface. Returns the resulting
 * state. Never throws for an expected failure (unreachable seller, no payable
 * 402) — those leave the state unchanged so the next boot retries; only the paid
 * smoke can advance it.
 */
export async function runAutopilot(
  surface: PaycallSurface,
  arg: AutopilotDeps | { onLive: () => void }
): Promise<AutopilotState> {
  const t = tag(surface);
  const resetCmd = `npm run ${surface.id}:reset`;
  const deps: AutopilotDeps = "readState" in arg ? arg : defaultDeps(surface, arg.onLive);
  const state = await deps.readState();

  if (state.stage === "live") {
    console.log(
      `[${t}] already live (smoke tx ${state.smokeTx ?? "?"} on ${state.ticker ?? "?"}) — scheduling weekly sweep`
    );
    deps.onLive();
    return state;
  }

  if (state.stage === "smoking") {
    console.error(
      `[${t}] previous smoke test is unconfirmed (stage=smoking). ` +
        "HALTING to avoid a repeated payment — check Solscan for the last tx, then " +
        `\`${resetCmd}\` to retry (or set the marker to live if it settled).`
    );
    return state;
  }

  // stage === "unstarted": confirm the wiring with an unpaid run 0 first.
  console.log(`[${t}] onboarding — run 0 (unpaid) / price ${priceSummary(surface)}`);
  const disc = await deps.runDiscovery();
  const payable = disc.records.find((r) => r.payable === true);
  if (!payable) {
    console.warn(
      `[${t}] run 0 found no payable 402 ` +
        "(seller unreachable, or the 402 is not Solana / USDC / exact price). " +
        "Not paying; will retry on the next boot."
    );
    return state;
  }
  console.log(
    `[${t}] run 0 OK — ${payable.ticker} offered a payable 402 ` +
      `(units ${payable.quotedUnits?.join(" ") ?? "?"}). Proceeding to a 1-item mainnet smoke.`
  );

  if (!deps.durable) {
    console.error(
      `[${t}] refusing the paid smoke: no durable state store (Upstash) configured, ` +
        "so a redeploy could re-pay. Set UPSTASH_REDIS_REST_* and retry."
    );
    return state;
  }

  // Mark intent BEFORE paying, so a crash between pay and confirm cannot re-pay.
  await deps.writeState({ stage: "smoking", ticker: payable.ticker, at: new Date().toISOString() });

  const smoke = await deps.runSmoke([payable.ticker]);
  const paid = smoke.records.find((r) => r.outcome === "paid" && r.txHash);
  if (!paid) {
    const rec = smoke.records[0];
    // "skipped" (policy filtered every requirement, nothing signed) and "free"
    // (no 402) are provably no-funds-moved, so roll back and retry next boot. An
    // "error" (or no record) is ambiguous — a payment MAY have settled — so keep
    // "smoking" and halt, guarding against a silent double-pay.
    const noFundsMoved = rec !== undefined && (rec.outcome === "skipped" || rec.outcome === "free");
    if (noFundsMoved) {
      await deps.writeState({ stage: "unstarted", at: new Date().toISOString() });
      console.warn(
        `[${t}] smoke did not settle but no funds moved (outcome=${rec.outcome}, ` +
          `reason=${rec.reason ?? "?"}). Rolled back to unstarted — will retry on the next boot.`
      );
      return { stage: "unstarted" };
    }
    console.error(
      `[${t}] smoke ambiguous (outcome=${rec?.outcome ?? "none"}, reason=${rec?.reason ?? "?"}) — ` +
        `a payment may have settled. Left at stage=smoking. Check Solscan, then \`${resetCmd}\`.`
    );
    return { stage: "smoking", ticker: payable.ticker };
  }

  const live: AutopilotState = {
    stage: "live",
    ticker: paid.ticker,
    smokeTx: paid.txHash,
    at: new Date().toISOString(),
  };
  await deps.writeState(live);
  console.log(
    `[${t}] LIVE — smoke settled: item=${paid.ticker} tx=${paid.txHash} ($${paid.actualUsdc}) ` +
      `sample=${paid.summary ?? "(none)"}. Scheduling the weekly sweep; the agent now self-drives.`
  );
  deps.onLive();
  return live;
}

/** Catalyst-bound entry, kept for existing callers/tests. */
export function runCatalystAutopilot(
  arg: AutopilotDeps | { onLive: () => void }
): Promise<AutopilotState> {
  return runAutopilot(CATALYST_SURFACE, arg);
}

/** EDINET-bound entry. */
export function runEdinetAutopilot(
  arg: AutopilotDeps | { onLive: () => void }
): Promise<AutopilotState> {
  return runAutopilot(EDINET_SURFACE, arg);
}
