import * as fs from "fs";
import * as path from "path";
import { ENDPOINTS_MODE_D } from "../config";
import { callEndpoint, getConsecutiveFailures } from "../caller";
import { logRun } from "../logger";
import { sendWebhookSummary } from "../notify";
import type { EndpointResult, RunLog } from "../types";

/**
 * Mode D — daily consumption of osd's published alpha + track-record endpoints.
 *
 * The agent pays per call in Solana USDC (x402) to read osd's US/JP portfolios,
 * scorecards, and JP catalysts, and persists each daily snapshot as append-only
 * provenance under data/alpha/. Read-only: Mode D never submits or mutates.
 * (Catalyst submit / per-id score are a separate action loop, not wired here.)
 */

const FAILURE_ALERT_THRESHOLD = 3;

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Persist each captured alpha snapshot as append-only provenance (the track record). */
function saveAlphaSnapshots(
  results: EndpointResult[],
  endpointIdByUrl: Map<string, string>,
  date: string
): void {
  const alphaDir = path.join(process.cwd(), "data", "alpha");
  const txDir = path.join(process.cwd(), "data", "transactions");
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(txDir, { recursive: true });

  const txEntries: Array<{ name: string; endpointId: string; txHash?: string; costUsdc: number }> = [];

  for (const result of results) {
    const id = endpointIdByUrl.get(result.endpoint);
    if (!id) continue;

    if (result.status === "success" && result.fullData) {
      const filePath = path.join(alphaDir, `${id}-${date}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ fetched_at: new Date().toISOString(), data: result.fullData }, null, 2),
        "utf-8"
      );
      console.log(`[MODE D] Alpha snapshot saved: ${filePath}`);
    }

    if (result.txHash) {
      txEntries.push({
        name: result.product,
        endpointId: id,
        txHash: result.txHash,
        costUsdc: result.costUsdc,
      });
    }
  }

  if (txEntries.length > 0) {
    const txPath = path.join(txDir, `alpha-${date}.json`);
    fs.writeFileSync(txPath, JSON.stringify({ date, transactions: txEntries }, null, 2), "utf-8");
    console.log(`[MODE D] Transaction log saved: ${txPath}`);
  }
}

export async function runModeD(): Promise<void> {
  const startMs = Date.now();
  const date = todayDate();
  console.log(`[MODE D] Alpha consumption started — ${ENDPOINTS_MODE_D.length} endpoints`);

  const log: RunLog = {
    timestamp: new Date().toISOString(),
    mode: "D",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 0,
    errors: [],
  };

  const endpointIdByUrl = new Map(ENDPOINTS_MODE_D.map((ep) => [ep.url, ep.id]));

  for (const ep of ENDPOINTS_MODE_D) {
    const result = await callEndpoint(ep);
    log.results.push(result);

    if (result.status === "success") {
      log.totalCostUsdc += result.costUsdc;
      log.totalTxCount += 1;
      console.log(`[MODE D] ✓ ${ep.name} — ${result.responsePeek}`);
    } else if (result.status === "degraded") {
      log.totalCostUsdc += result.costUsdc;
      log.totalDegradedCount += 1;
      console.warn(`[MODE D] ~ ${ep.name} — degraded: ${result.degradedReason}`);
    } else {
      log.errors.push(`${ep.name}: ${result.error ?? "unknown error"}`);
      console.error(`[MODE D] ✗ ${ep.name} — ${result.error}`);
      const consecutive = getConsecutiveFailures(ep);
      if (consecutive >= FAILURE_ALERT_THRESHOLD) {
        console.warn(`[ALERT] ${ep.name} has failed ${consecutive} consecutive times`);
      }
    }
  }

  saveAlphaSnapshots(log.results, endpointIdByUrl, date);

  log.durationMs = Date.now() - startMs;
  logRun(log);
  await sendWebhookSummary(log);

  const ok = log.results.filter((r) => r.status === "success").length;
  const ng = log.results.filter((r) => r.status === "error").length;
  console.log(
    `[MODE D] Complete — ${ok} OK, ${log.totalDegradedCount} degraded, ${ng} errors, $${log.totalCostUsdc.toFixed(3)} USDC, ${Math.round(log.durationMs / 1000)}s`
  );
}
