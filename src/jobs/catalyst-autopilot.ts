/**
 * Catalyst self-onboarding ("autopilot").
 *
 * The point of the sweep is that the agent runs it — not that a human clicks
 * dry-run, then mainnet, then flips a flag. When CATALYST_AUTOPILOT=true the
 * agent drives that sequence itself at boot:
 *
 *   unstarted → run0 (unpaid; confirm the 402 is Solana / USDC / exactly 100
 *               units) → pay ONE mainnet ticker (confirm a real Solscan tx)
 *             → live → schedule the weekly sweep.
 *
 * Idempotency is the whole safety story, because Railway redeploys on every
 * push and a boot-time paid step would otherwise re-pay (or re-loop) each time:
 *
 *   - State is persisted (Upstash; local file only as a dev fallback). Once
 *     "live", later boots skip straight to scheduling — no second smoke payment.
 *   - The paid smoke writes "smoking" BEFORE it pays. If a boot finds "smoking",
 *     the previous attempt did not confirm — the agent HALTS rather than paying
 *     again, so a crash loop cannot pay on every boot. A human glance at Solscan
 *     resolves it (reset the marker). This trades a little autonomy for the
 *     guarantee that unattended really is safe.
 *
 * All the guards from the sweep still apply underneath: the exact-requirement
 * safety valve and the weekly cap run before signing, so even a bug here cannot
 * pay the wrong amount or blow the cap.
 */
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";
import { runCatalystSweep, type CatalystRunReport } from "./catalyst-sweep";
import { priceSummary } from "../catalyst/client";
import * as fs from "fs";
import * as path from "path";

export type AutopilotStage = "unstarted" | "smoking" | "live";

export interface AutopilotState {
  stage: AutopilotStage;
  /** Ticker the smoke test paid. */
  ticker?: string;
  /** Settlement tx of the smoke payment (Solscan). */
  smokeTx?: string;
  at?: string;
}

const REDIS_KEY = "catalyst_autopilot:state";
const localFile = () => path.join(process.cwd(), "data", "catalyst", "autopilot-state.json");

export async function readAutopilotState(): Promise<AutopilotState> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string | null>(["GET", REDIS_KEY]);
      if (raw) return JSON.parse(raw) as AutopilotState;
      return { stage: "unstarted" };
    } catch (err) {
      console.warn(`[CATALYST-AUTOPILOT] state read failed: ${String(err)}`);
    }
  }
  try {
    return JSON.parse(fs.readFileSync(localFile(), "utf-8")) as AutopilotState;
  } catch {
    return { stage: "unstarted" };
  }
}

export async function writeAutopilotState(state: AutopilotState): Promise<void> {
  const value = JSON.stringify(state);
  if (upstashConfigured()) {
    try {
      await upstashCommand(["SET", REDIS_KEY, value]);
    } catch (err) {
      console.warn(`[CATALYST-AUTOPILOT] state write failed: ${String(err)}`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(localFile()), { recursive: true });
    fs.writeFileSync(localFile(), value, "utf-8");
  } catch (err) {
    console.warn(`[CATALYST-AUTOPILOT] local state write failed: ${String(err)}`);
  }
}

export interface AutopilotDeps {
  readState: () => Promise<AutopilotState>;
  writeState: (s: AutopilotState) => Promise<void>;
  /** Unpaid discovery. */
  runDiscovery: () => Promise<CatalystRunReport>;
  /** Paid smoke of exactly the given tickers. */
  runSmoke: (tickers: string[]) => Promise<CatalystRunReport>;
  /** Whether the durable store is available; the paid smoke needs it. */
  durable: boolean;
  /** Called once the agent is live, to schedule the weekly sweep. */
  onLive: () => void;
}

function defaultDeps(onLive: () => void): AutopilotDeps {
  return {
    readState: readAutopilotState,
    writeState: writeAutopilotState,
    runDiscovery: () => runCatalystSweep({ mode: "discovery" }),
    runSmoke: (tickers) => runCatalystSweep({ mode: "sweep", tickers }),
    durable: upstashConfigured(),
    onLive,
  };
}

/**
 * Drive the onboarding one step per boot. Returns the resulting state. Never
 * throws for an expected failure (unreachable seller, no payable 402) — those
 * leave the state unchanged so the next boot retries; only the paid smoke can
 * advance it.
 */
export async function runCatalystAutopilot(
  arg: AutopilotDeps | { onLive: () => void }
): Promise<AutopilotState> {
  const deps: AutopilotDeps = "readState" in arg ? arg : defaultDeps(arg.onLive);
  const state = await deps.readState();

  if (state.stage === "live") {
    console.log(
      `[CATALYST-AUTOPILOT] already live (smoke tx ${state.smokeTx ?? "?"} on ${state.ticker ?? "?"}) — scheduling weekly sweep`
    );
    deps.onLive();
    return state;
  }

  if (state.stage === "smoking") {
    // A prior boot paid (or was about to) and never confirmed. Do not pay again.
    console.error(
      "[CATALYST-AUTOPILOT] previous smoke test is unconfirmed (stage=smoking). " +
        "HALTING to avoid a repeated payment — check Solscan for the last tx and " +
        `reset ${REDIS_KEY} to {\"stage\":\"unstarted\"} (or \"live\" if it settled) to continue.`
    );
    return state;
  }

  // stage === "unstarted": confirm the wiring with an unpaid run 0 first.
  console.log(`[CATALYST-AUTOPILOT] onboarding — run 0 (unpaid) / price ${priceSummary()}`);
  const disc = await deps.runDiscovery();
  const payable = disc.records.find((r) => r.payable === true);
  if (!payable) {
    console.warn(
      "[CATALYST-AUTOPILOT] run 0 found no payable 402 " +
        "(seller unreachable, or the 402 is not Solana / USDC / exact price). " +
        "Not paying; will retry on the next boot."
    );
    return state;
  }
  console.log(
    `[CATALYST-AUTOPILOT] run 0 OK — ${payable.ticker} offered a payable 402 ` +
      `(units ${payable.quotedUnits?.join(" ") ?? "?"}). Proceeding to a 1-ticker mainnet smoke.`
  );

  if (!deps.durable) {
    console.error(
      "[CATALYST-AUTOPILOT] refusing the paid smoke: no durable state store (Upstash) " +
        "configured, so a redeploy could re-pay. Set UPSTASH_REDIS_REST_* and retry."
    );
    return state;
  }

  // Mark intent BEFORE paying, so a crash between pay and confirm cannot re-pay.
  await deps.writeState({ stage: "smoking", ticker: payable.ticker, at: new Date().toISOString() });

  const smoke = await deps.runSmoke([payable.ticker]);
  const paid = smoke.records.find((r) => r.outcome === "paid" && r.txHash);
  if (!paid) {
    const rec = smoke.records[0];
    console.error(
      `[CATALYST-AUTOPILOT] smoke did NOT settle (outcome=${rec?.outcome ?? "?"}, ` +
        `reason=${rec?.reason ?? "?"}). Left at stage=smoking — a human must check ` +
        "before it will continue (guards against silent re-payment)."
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
    `[CATALYST-AUTOPILOT] LIVE — smoke settled: ticker=${paid.ticker} ` +
      `tx=${paid.txHash} ($${paid.actualUsdc}) sample=${paid.summary ?? "(none)"}. ` +
      "Scheduling the weekly sweep; the agent now self-drives."
  );
  deps.onLive();
  return live;
}
