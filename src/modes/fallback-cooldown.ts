/**
 * Per-endpoint fallback cooldown for Mode B.
 *
 * A seller that answers 200 but with degraded/fallback data still charges full
 * price (x402 pays before the body is seen, and the fallback marker lives inside
 * the paid response). Paying $0.30/day for fallback data indefinitely is waste,
 * so after N consecutive degraded days an endpoint is put in cooldown and the
 * daily purchase is skipped. To catch its return to live, a low-frequency probe
 * still buys it once every P days while in cooldown; a live result clears the
 * cooldown and the daily purchase resumes.
 *
 * State is persisted (Upstash; local file fallback), because Railway's disk
 * resets on redeploy and a counter that resets is not a cooldown.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Consecutive degraded days before an endpoint is cooled down. */
export const FALLBACK_DAYS = num("FALLBACK_COOLDOWN_DAYS", 3);
/** While cooled down, buy once every this many days to test for recovery. */
export const PROBE_INTERVAL_DAYS = num("FALLBACK_PROBE_INTERVAL_DAYS", 3);

export type CallOutcome = "live" | "fallback" | "error";

export interface CooldownState {
  endpointId: string;
  /** Consecutive degraded days observed. */
  consecutiveFallback: number;
  inCooldown: boolean;
  /** YYYY-MM-DD this endpoint was last counted (guards double-count on same-day reruns). */
  lastCountedDate?: string;
  /** YYYY-MM-DD of the last call made while in cooldown (a probe). */
  lastProbeDate?: string;
  /** When the cooldown started. */
  since?: string;
}

export function initialState(endpointId: string): CooldownState {
  return { endpointId, consecutiveFallback: 0, inCooldown: false };
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z");
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Infinity;
}

export interface CallPlan {
  /** Whether to call the endpoint at all today. */
  call: boolean;
  /** True when the call is a recovery probe (endpoint is in cooldown). */
  probe: boolean;
}

/** Decide whether to buy an endpoint today given its cooldown state. Pure. */
export function decideCall(state: CooldownState, today: string): CallPlan {
  if (!state.inCooldown) return { call: true, probe: false };
  const since = state.lastProbeDate ?? state.since;
  const elapsed = since ? daysBetween(since, today) : Infinity;
  if (elapsed >= PROBE_INTERVAL_DAYS) return { call: true, probe: true };
  return { call: false, probe: false };
}

/** Next state after an outcome. Pure. `wasProbe` is CallPlan.probe. */
export function nextState(
  state: CooldownState,
  today: string,
  outcome: CallOutcome,
  wasProbe: boolean
): CooldownState {
  if (outcome === "live") {
    // Healthy (or recovered): clear everything.
    return { endpointId: state.endpointId, consecutiveFallback: 0, inCooldown: false, lastCountedDate: today };
  }
  if (outcome === "error") {
    // A transient error is not fallback — don't advance the counter; just note a probe.
    return { ...state, lastProbeDate: wasProbe ? today : state.lastProbeDate };
  }
  // fallback
  if (state.lastCountedDate === today) {
    // Already counted today (a same-day rerun) — don't double-count.
    return { ...state, lastProbeDate: wasProbe ? today : state.lastProbeDate };
  }
  const consecutiveFallback = state.consecutiveFallback + 1;
  const inCooldown = state.inCooldown || consecutiveFallback >= FALLBACK_DAYS;
  return {
    endpointId: state.endpointId,
    consecutiveFallback,
    inCooldown,
    lastCountedDate: today,
    lastProbeDate: wasProbe ? today : state.lastProbeDate,
    since: inCooldown ? state.since ?? today : state.since,
  };
}

// ── persistence ──────────────────────────────────────────────────────────────

const redisKey = (id: string) => `fallback_cooldown:${id}`;
const localFile = () => path.join(process.cwd(), "data", "cooldown", "fallback.json");

function readLocalAll(): Record<string, CooldownState> {
  try {
    return JSON.parse(fs.readFileSync(localFile(), "utf-8")) as Record<string, CooldownState>;
  } catch {
    return {};
  }
}

export async function loadCooldown(endpointId: string): Promise<CooldownState> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string | null>(["GET", redisKey(endpointId)]);
      if (raw) return JSON.parse(raw) as CooldownState;
      return initialState(endpointId);
    } catch (err) {
      console.warn(`[COOLDOWN] read failed for ${endpointId}: ${String(err)}`);
    }
  }
  return readLocalAll()[endpointId] ?? initialState(endpointId);
}

export async function saveCooldown(state: CooldownState): Promise<void> {
  if (upstashConfigured()) {
    try {
      await upstashCommand(["SET", redisKey(state.endpointId), JSON.stringify(state)]);
    } catch (err) {
      console.warn(`[COOLDOWN] write failed for ${state.endpointId}: ${String(err)}`);
    }
  }
  try {
    const all = readLocalAll();
    all[state.endpointId] = state;
    fs.mkdirSync(path.dirname(localFile()), { recursive: true });
    fs.writeFileSync(localFile(), JSON.stringify(all), "utf-8");
  } catch (err) {
    console.warn(`[COOLDOWN] local write failed for ${state.endpointId}: ${String(err)}`);
  }
}

/** Human-readable cooldown reason for the dashboard row. */
export function cooldownReason(state: CooldownState): string {
  return `cooldown: ${state.consecutiveFallback}日連続で劣化データのため購入停止中(live復帰を確認中)`;
}
