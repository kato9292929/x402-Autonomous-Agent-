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
    lines.push(
      `[RUN]  ${icon} ${r.product} $${(r.costUsdc ?? 0).toFixed(3)}` +
        (r.txHash ? ` tx=${r.txHash}` : "") +
        (note ? ` — ${String(note).slice(0, 160)}` : "")
    );
  }

  for (const e of log.errors ?? []) lines.push(`[RUN]  ! ${e}`);

  return lines;
}

export function logRun(log: RunLog): void {
  for (const line of formatRunSummary(log)) console.log(line);
}
