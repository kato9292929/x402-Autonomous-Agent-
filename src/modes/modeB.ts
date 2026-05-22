import { ENDPOINTS_MODE_B } from "../config";
import { callEndpoint, getConsecutiveFailures } from "../caller";
import { logRun } from "../logger";
import { sendWebhookSummary } from "../notify";
import type { RunLog } from "../types";

const FAILURE_ALERT_THRESHOLD = 3;

export async function runModeB(): Promise<void> {
  const startMs = Date.now();
  console.log(`[MODE B] Daily briefing started — ${ENDPOINTS_MODE_B.length} endpoints`);

  const log: RunLog = {
    timestamp: new Date().toISOString(),
    mode: "B",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    durationMs: 0,
    errors: [],
  };

  for (const ep of ENDPOINTS_MODE_B) {
    const result = await callEndpoint(ep);
    log.results.push(result);

    if (result.status === "success") {
      log.totalCostUsdc += result.costUsdc;
      log.totalTxCount += 1;
      console.log(`[MODE B] ✓ ${ep.name} — ${result.responsePeek}`);
    } else {
      log.errors.push(`${ep.name}: ${result.error ?? "unknown error"}`);
      console.error(`[MODE B] ✗ ${ep.name} — ${result.error}`);

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
    `[MODE B] Complete — ${ok} OK, ${ng} errors, $${log.totalCostUsdc.toFixed(3)} USDC, ${Math.round(log.durationMs / 1000)}s`
  );
}
