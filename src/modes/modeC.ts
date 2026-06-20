import { ENDPOINTS_MODE_C } from "../config";
import { callEndpoint, getConsecutiveFailures } from "../caller";
import { logRun } from "../logger";
import { sendWebhookSummary } from "../notify";
import type { RunLog } from "../types";
import { enqueueApproval } from "../world-id/queue";

const FAILURE_ALERT_THRESHOLD = 3;

/**
 * Queue Mode C for human approval instead of running it directly.
 * The Monday cron calls this; actual execution is triggered via /approve after World ID verification.
 */
export function queueModeC(): string {
  const item = enqueueApproval();
  const baseUrl =
    process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "http://localhost:3000";
  const approveUrl = `${baseUrl}/approve?id=${item.id}`;
  console.log(`[MODE C] Weekly run queued for approval — id=${item.id}`);
  console.log(`[MODE C] Approval URL: ${approveUrl}`);
  return item.id;
}

export async function runModeC(): Promise<void> {
  const startMs = Date.now();
  console.log(`[MODE C] Weekly report started — ${ENDPOINTS_MODE_C.length} endpoints`);

  const log: RunLog = {
    timestamp: new Date().toISOString(),
    mode: "C",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 0,
    errors: [],
  };

  for (const ep of ENDPOINTS_MODE_C) {
    const result = await callEndpoint(ep);
    log.results.push(result);

    if (result.status === "success") {
      log.totalCostUsdc += result.costUsdc;
      log.totalTxCount += 1;
      console.log(`[MODE C] ✓ ${ep.name} — ${result.responsePeek}`);
    } else {
      log.errors.push(`${ep.name}: ${result.error ?? "unknown error"}`);
      console.error(`[MODE C] ✗ ${ep.name} — ${result.error}`);

      const consecutive = getConsecutiveFailures(ep);
      if (consecutive >= FAILURE_ALERT_THRESHOLD) {
        console.warn(
          `[ALERT] ${ep.name} has failed ${consecutive} consecutive times`
        );
      }
    }
  }

  log.durationMs = Date.now() - startMs;
  logRun(log);
  await sendWebhookSummary(log);

  const ok = log.results.filter((r) => r.status === "success").length;
  const ng = log.results.filter((r) => r.status === "error").length;
  console.log(
    `[MODE C] Complete — ${ok} OK, ${ng} errors, $${log.totalCostUsdc.toFixed(2)} USDC, ${Math.round(log.durationMs / 1000)}s`
  );
}
