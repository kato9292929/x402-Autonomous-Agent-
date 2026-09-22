import type { RunLog } from "./types";

/**
 * Compact, human-readable run summary for stdout.
 *
 * This used to be `JSON.stringify(log, null, 2)`, which pretty-printed every
 * result's `fullData` — roughly a thousand lines per run, enough to hit
 * Railway's 500 logs/sec limit and drop messages. `fullData` is already
 * persisted by saveRun and by the Mode B/D snapshot files, so dumping it to
 * stdout bought nothing and cost observability.
 *
 * One header line plus one line per endpoint. Never includes `fullData`.
 */
/** Response peeks are samples — a short one is enough to eyeball the shape. */
const PEEK_MAX_CHARS = 160;

/**
 * Errors keep far more room than peeks. The run summary is the line an incident
 * is actually read from, and at 160 it cut a CDP facilitator failure off mid
 * `{"errorMessage":"A val` — the sentence naming the cause never made it in.
 */
const ERROR_NOTE_MAX_CHARS = 1200;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function formatRunSummary(log: RunLog): string[] {
  const results = log.results ?? [];
  const ok = results.filter((r) => r.status === "success").length;
  const deg = log.totalDegradedCount ?? results.filter((r) => r.status === "degraded").length;
  const err = results.filter((r) => r.status === "error").length;

  const lines: string[] = [
    `[RUN] mode=${log.mode} at=${log.timestamp} ok=${ok} degraded=${deg} error=${err} ` +
      `cost=$${(log.totalCostUsdc ?? 0).toFixed(3)} tx=${log.totalTxCount ?? 0} ` +
      `dur=${Math.round((log.durationMs ?? 0) / 1000)}s`,
  ];

  for (const r of results) {
    const icon = r.status === "success" ? "✓" : r.status === "degraded" ? "~" : "✗";
    const note =
      r.status === "error"
        ? (r.error ?? "unknown error")
        : (r.degradedReason ?? r.responsePeek ?? "");
    // A response peek is a sample and stays short; an error is the only record
    // of why the call failed, so it keeps room for the facilitator's own
    // message. 160 truncated it mid-envelope and hid the cause for days.
    const limit = r.status === "error" ? ERROR_NOTE_MAX_CHARS : PEEK_MAX_CHARS;
    lines.push(
      `[RUN]  ${icon} ${r.product} $${(r.costUsdc ?? 0).toFixed(3)}` +
        (r.settledNetwork ? ` via=${r.settledNetwork}` : "") +
        (r.txHash ? ` tx=${r.txHash}` : "") +
        (note ? ` — ${clip(String(note), limit)}` : "")
    );
  }

  for (const e of log.errors ?? []) lines.push(`[RUN]  ! ${clip(e, ERROR_NOTE_MAX_CHARS)}`);

  return lines;
}

export function logRun(log: RunLog): void {
  for (const line of formatRunSummary(log)) console.log(line);
}
