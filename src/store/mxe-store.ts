/**
 * Append-only store for MXE computation records (`mxe_trades`).
 *
 * Mirrors probe-store: Upstash Redis REST (LPUSH, newest first) when configured,
 * and a local JSONL that is always appended. Unlike the probe store the list is
 * never trimmed — the brief's aggregates (processing time, cost, 単価比 per
 * function) are taken over every record, and a trimmed list would quietly drop
 * the early runs from them. Records are written once and never rewritten.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "./upstash-rest";
import type { MxeTradeRecord } from "../mxe/record";

const MXE_KEY = "mxe_trades";

function dir(): string {
  return path.join(process.cwd(), "data", "mxe");
}
function file(): string {
  return path.join(dir(), "mxe-trades.jsonl");
}

/** Persist one record. Never throws: a failed save is logged, not hidden. */
export async function saveMxeRecord(rec: MxeTradeRecord): Promise<void> {
  const line = JSON.stringify(rec);
  if (upstashConfigured()) {
    try {
      await upstashCommand(["LPUSH", MXE_KEY, line]);
    } catch (err) {
      console.error(`[MXE-STORE] Upstash save failed: ${String(err)}`);
    }
  } else {
    console.warn(
      "[MXE-STORE] Upstash not configured — this record is only on local disk, " +
        "which Railway wipes on redeploy (set UPSTASH_REDIS_REST_URL / _TOKEN)"
    );
  }
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(file(), line + "\n", "utf-8");
  } catch (err) {
    console.error(`[MXE-STORE] local save failed: ${String(err)}`);
  }
}

/** Load records, newest first. `limit` undefined loads all of them. */
export async function loadMxeRecords(limit?: number): Promise<MxeTradeRecord[]> {
  const end = limit === undefined ? -1 : limit - 1;
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string[]>(["LRANGE", MXE_KEY, 0, end]);
      if (Array.isArray(raw)) return parseLines(raw);
    } catch (err) {
      console.error(`[MXE-STORE] Upstash load failed: ${String(err)}`);
    }
  }
  try {
    if (!fs.existsSync(file())) return [];
    const lines = fs.readFileSync(file(), "utf-8").trim().split("\n").filter(Boolean);
    const newestFirst = parseLines(lines.reverse());
    return limit === undefined ? newestFirst : newestFirst.slice(0, limit);
  } catch (err) {
    console.error(`[MXE-STORE] local load failed: ${String(err)}`);
    return [];
  }
}

function parseLines(lines: string[]): MxeTradeRecord[] {
  const out: MxeTradeRecord[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as MxeTradeRecord);
    } catch {
      // A truncated line is skipped rather than failing the whole read.
    }
  }
  return out;
}
