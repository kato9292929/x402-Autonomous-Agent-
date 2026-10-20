/**
 * Durable store for external-probe runs.
 *
 * The probe's call records used to live only in `data/probe/probe-calls.csv`,
 * i.e. on Railway's local disk, which is wiped on every redeploy. The weekly
 * spend ledger was moved to Upstash for exactly that reason (`probe/budget.ts`),
 * but the rows themselves were left behind — so the record of what we paid third
 * parties, and what they returned, did not survive a deploy and had no surface
 * the dashboard could read.
 *
 * Mirrors the run-store pattern:
 *   1. Upstash Redis REST — LPUSH onto `probe_runs` (newest first), LTRIM to a cap.
 *   2. Local JSONL (data/probe/probe-runs.jsonl) — always appended.
 *
 * The CSV stays as it is. It carries the human-scored `quality` column, which is
 * a working file rather than a record of fact, and it is written by hand.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "./upstash-rest";
import type { ProbeCallRecord, TargetSummary } from "../probe/record";

const PROBE_KEY = "probe_runs";
/** ~1 year of weekly sweeps plus the run-0s interleaved between them. */
const MAX_PROBE_RUNS = 120;
const DIR = path.join(process.cwd(), "data", "probe");
const FILE = path.join(DIR, "probe-runs.jsonl");

export interface ProbeRunSummary {
  /** "discovery" (run 0, unpaid) or "sweep" (paid). */
  mode: "discovery" | "sweep";
  /** ISO timestamp the run finished. */
  at: string;
  /** ISO week key the run belongs to. */
  week: string;
  /** USDC spent in this run. Always 0 for discovery. */
  runSpentUsdc: number;
  /** USDC spent in the week after this run. */
  weekSpentUsdc: number;
  /** Per-seller rollup, derived from `records`. */
  summaries: TargetSummary[];
  /** One row per call attempted. */
  records: ProbeCallRecord[];
}

/** Persist one probe run (newest first in Upstash; appended to local JSONL). */
export async function saveProbeRun(run: ProbeRunSummary): Promise<void> {
  const line = JSON.stringify(run);

  if (upstashConfigured()) {
    try {
      await upstashCommand(["LPUSH", PROBE_KEY, line]);
      await upstashCommand(["LTRIM", PROBE_KEY, 0, MAX_PROBE_RUNS - 1]);
    } catch (err) {
      console.error(`[PROBE-STORE] Upstash save failed: ${String(err)}`);
    }
  } else {
    // Without Upstash the only copy is on ephemeral disk. Say so rather than
    // letting the run look recorded.
    console.warn(
      "[PROBE-STORE] Upstash not configured — this run is only on local disk, " +
        "which Railway wipes on redeploy (set UPSTASH_REDIS_REST_URL / _TOKEN)"
    );
  }

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, line + "\n", "utf-8");
  } catch (err) {
    console.error(`[PROBE-STORE] local save failed: ${String(err)}`);
  }
}

/** Load the most recent probe runs, newest first. */
export async function loadProbeRuns(limit = 20): Promise<ProbeRunSummary[]> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string[]>(["LRANGE", PROBE_KEY, 0, limit - 1]);
      if (Array.isArray(raw)) return parseLines(raw);
    } catch (err) {
      console.error(`[PROBE-STORE] Upstash load failed: ${String(err)}`);
    }
  }

  try {
    if (!fs.existsSync(FILE)) return [];
    const lines = fs.readFileSync(FILE, "utf-8").trim().split("\n").filter(Boolean);
    // JSONL is append-order (oldest first); the API contract is newest first.
    return parseLines(lines.reverse()).slice(0, limit);
  } catch (err) {
    console.error(`[PROBE-STORE] local load failed: ${String(err)}`);
    return [];
  }
}

function parseLines(lines: string[]): ProbeRunSummary[] {
  const out: ProbeRunSummary[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as ProbeRunSummary);
    } catch {
      // A truncated line is skipped rather than failing the whole read.
    }
  }
  return out;
}

/**
 * The newest paid sweep, which is what the dashboard headlines.
 *
 * Discovery runs are excluded on purpose: they pay nothing, so showing one as
 * "the latest external settlement" would overstate what happened.
 */
export function latestSweep(runs: ProbeRunSummary[]): ProbeRunSummary | undefined {
  return runs.find((r) => r.mode === "sweep");
}
