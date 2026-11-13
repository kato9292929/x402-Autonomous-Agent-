/**
 * Stops a function that keeps failing the same way, so it does not keep
 * spending devnet SOL on computations that will not run.
 *
 * Rule: when a function's runs on its last 3 run days (JST) all failed, and
 * all at the same stage (stage.ts), it is paused. A paused function is not run;
 * each scheduled run writes a `paused` record for it instead, so the gap is
 * visible. It stays paused until resumed by hand (`npm run mxe:resume -- <fn|all>`
 * in the Railway console), which records the resume time: runs before it no
 * longer count, so the function gets three fresh days before it can pause again.
 *
 * State lives in Upstash (hash `mxe_breaker`), with a local file as fallback.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashCommand, upstashConfigured } from "../store/upstash-rest";
import type { MxeFunction, MxeTradeRecord } from "./record";
import { STAGE_LABELS, stageOf, type MxeStage } from "./stage";

export const BREAKER_DAYS = 3;
const KEY = "mxe_breaker";

export interface BreakerState {
  paused?: { at: string; stage: MxeStage; days: string[]; reason: string };
  /** Runs before this no longer count toward a pause. */
  resumedAt?: string;
}

const file = () => path.join(process.cwd(), "data", "mxe", "breaker.json");

function readLocal(): Record<string, BreakerState> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf-8"));
  } catch {
    return {};
  }
}

export async function loadBreaker(): Promise<Record<number, BreakerState>> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string[]>(["HGETALL", KEY]);
      const out: Record<number, BreakerState> = {};
      if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) out[Number(raw[i])] = JSON.parse(raw[i + 1]);
      return out;
    } catch (err) {
      console.error(`[MXE-BREAKER] Upstash load failed: ${String(err)}`);
    }
  }
  return readLocal();
}

export async function saveBreaker(fn: MxeFunction, state: BreakerState): Promise<void> {
  if (upstashConfigured()) {
    try {
      await upstashCommand(["HSET", KEY, String(fn), JSON.stringify(state)]);
    } catch (err) {
      console.error(`[MXE-BREAKER] Upstash save failed: ${String(err)}`);
    }
  }
  try {
    const all = readLocal();
    all[fn] = state;
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
  } catch (err) {
    console.error(`[MXE-BREAKER] local save failed: ${String(err)}`);
  }
}

/** JST calendar day of a record. */
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * Whether `fn` should be paused, from its records (any order). Returns the
 * pause to store, or undefined.
 */
export function shouldPause(records: MxeTradeRecord[], fn: MxeFunction, state: BreakerState = {}): BreakerState["paused"] {
  const since = state.resumedAt ? Date.parse(state.resumedAt) : -Infinity;
  const rs = records.filter(
    (r) => r.fn === fn && Date.parse(r.at) > since && r.status !== "paused" && r.status !== "disabled"
  );
  const byDay = new Map<string, MxeTradeRecord[]>();
  for (const r of rs) byDay.set(jstDay(r.at), [...(byDay.get(jstDay(r.at)) ?? []), r]);
  const days = [...byDay.keys()].sort().reverse().slice(0, BREAKER_DAYS);
  if (days.length < BREAKER_DAYS) return undefined;
  const stages = new Set<MxeStage | undefined>();
  for (const d of days) {
    for (const r of byDay.get(d)!) {
      if (r.status !== "failed") return undefined;
      stages.add(stageOf(r));
    }
  }
  if (stages.size !== 1) return undefined;
  const stage = [...stages][0];
  if (!stage) return undefined;
  const sample = byDay.get(days[0])![0].error ?? "";
  return {
    at: new Date().toISOString(),
    stage,
    days: [...days].reverse(),
    reason: `${BREAKER_DAYS}日続けて「${STAGE_LABELS[stage]}」で失敗(${[...days].reverse().join(", ")}): ${sample.slice(0, 160)}`,
  };
}

/** Clears a pause and starts the count afresh. */
export async function resume(fn: MxeFunction): Promise<void> {
  await saveBreaker(fn, { resumedAt: new Date().toISOString() });
}
