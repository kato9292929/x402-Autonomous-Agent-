/**
 * Append-only store for daily run summaries (RunLog from Mode A/B/C/D).
 *
 * Mirrors the decision-store pattern:
 *   1. Upstash Redis REST — LPUSH onto `agent_runs` (newest first), LTRIM to a cap,
 *      when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 *   2. Local JSONL (data/runs/runs.jsonl) — always appended.
 *
 * Railway's local disk is ephemeral (reset on redeploy), so Upstash is the durable
 * source the dashboard reads; the local file is a best-effort fallback for local dev.
 * Records are immutable: we only append.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "./upstash-rest";
import type { RunLog } from "../types";

const RUNS_KEY = "agent_runs";
const MAX_RUNS = 150; // keep the most recent ~150 runs (~7 weeks of daily B+A+D)
const DIR = path.join(process.cwd(), "data", "runs");
const FILE = path.join(DIR, "runs.jsonl");

/** Persist one run summary (newest first in Upstash; appended to local JSONL). */
export async function saveRun(log: RunLog): Promise<void> {
  const line = JSON.stringify(log);

  if (upstashConfigured()) {
    try {
      await upstashCommand(["LPUSH", RUNS_KEY, line]);
      await upstashCommand(["LTRIM", RUNS_KEY, 0, MAX_RUNS - 1]);
    } catch (err) {
      console.error(`[RUN-STORE] Upstash save failed: ${String(err)}`);
    }
  }

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, line + "\n", "utf-8");
  } catch (err) {
    console.error(`[RUN-STORE] local save failed: ${String(err)}`);
  }
}

/** Load the most recent runs, newest first. */
export async function loadRuns(limit = 60): Promise<RunLog[]> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string[]>(["LRANGE", RUNS_KEY, 0, limit - 1]);
      if (Array.isArray(raw)) {
        return raw
          .map((s) => {
            try {
              return JSON.parse(s) as RunLog;
            } catch {
              return null;
            }
          })
          .filter((r): r is RunLog => r !== null);
      }
    } catch (err) {
      console.error(`[RUN-STORE] Upstash load failed: ${String(err)}`);
    }
  }

  try {
    if (!fs.existsSync(FILE)) return [];
    const lines = fs.readFileSync(FILE, "utf-8").trim().split("\n").filter(Boolean);
    const parsed: RunLog[] = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l) as RunLog);
      } catch {
        /* skip malformed line */
      }
    }
    return parsed.reverse().slice(0, limit); // newest first
  } catch {
    return [];
  }
}
