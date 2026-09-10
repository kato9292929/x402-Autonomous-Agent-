import * as fs from "fs";
import * as path from "path";
import { ENDPOINTS_MODE_B } from "../config";
import { callEndpoint, getConsecutiveFailures } from "../caller";
import { logRun } from "../logger";
import { saveRun } from "../store/run-store";
import { sendWebhookSummary } from "../notify";
import { summarizeYield } from "./yield-observe";
import {
  loadCooldown,
  saveCooldown,
  decideCall,
  nextState,
  cooldownReason,
  type CallOutcome,
} from "./fallback-cooldown";
import type { EndpointResult, RunLog } from "../types";

const FAILURE_ALERT_THRESHOLD = 3;
const EXTERNAL_IDS = new Set([
  "osd-jin-latest",
  "osd-jin-movers",
]);

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function saveExternalData(
  results: EndpointResult[],
  endpointIdByUrl: Map<string, string>,
  date: string
): void {
  const externalDir = path.join(process.cwd(), "data", "external");
  const txDir = path.join(process.cwd(), "data", "transactions");
  ensureDir(externalDir);
  ensureDir(txDir);

  const txEntries: Array<{ name: string; endpointId: string; txHash?: string; costUsdc: number }> = [];

  for (const result of results) {
    const id = endpointIdByUrl.get(result.endpoint);
    if (!id || !EXTERNAL_IDS.has(id)) continue;

    const labelMap: Record<string, string> = {
      "osd-jin-latest": "jin-latest",
      "osd-jin-movers": "jin-movers",
    };
    const label = labelMap[id] ?? id;

    if (result.status === "success" && result.fullData) {
      const filePath = path.join(externalDir, `${label}-${date}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ fetched_at: new Date().toISOString(), data: result.fullData }, null, 2),
        "utf-8"
      );
      console.log(`[MODE B] External data saved: ${filePath}`);
    } else if (result.status === "error") {
      console.warn(`[MODE B] External data missing for ${label} — ${result.error}`);
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
    const txPath = path.join(txDir, `external-${date}.json`);
    fs.writeFileSync(
      txPath,
      JSON.stringify({ date, transactions: txEntries }, null, 2),
      "utf-8"
    );
    console.log(`[MODE B] Transaction log saved: ${txPath}`);
  }
}

export async function runModeB(): Promise<RunLog> {
  const startMs = Date.now();
  const date = todayDate();
  console.log(`[MODE B] Daily briefing started — ${ENDPOINTS_MODE_B.length} endpoints`);

  const log: RunLog = {
    timestamp: new Date().toISOString(),
    mode: "B",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    totalDegradedCount: 0,
    durationMs: 0,
    errors: [],
  };

  // Map URL → endpoint id for post-loop lookup
  const endpointIdByUrl = new Map(ENDPOINTS_MODE_B.map((ep) => [ep.url, ep.id]));

  for (const ep of ENDPOINTS_MODE_B) {
    // Skip an endpoint stuck serving fallback data — don't pay for degraded data
    // every day. A low-frequency probe still buys it to detect a return to live.
    const cd = await loadCooldown(ep.id);
    const plan = decideCall(cd, date);
    if (!plan.call) {
      log.results.push({
        endpoint: ep.url,
        product: ep.name,
        status: "degraded",
        costUsdc: 0,
        responsePeek: "",
        degradedReason: cooldownReason(cd),
        durationMs: 0,
      });
      console.log(`[MODE B] ⏸ ${ep.name} — cooldown, skipped (saved $${ep.cost.toFixed(2)})`);
      continue;
    }

    const result = await callEndpoint(ep);
    log.results.push(result);

    // Fold this outcome into the endpoint's cooldown state: a degraded result is
    // fallback, a success is live (and clears any cooldown). A probe that comes
    // back live resumes normal daily buying.
    const outcome: CallOutcome =
      result.status === "success" ? "live" : result.status === "degraded" ? "fallback" : "error";
    const wasCooled = cd.inCooldown;
    const ns = nextState(cd, date, outcome, plan.probe);
    await saveCooldown(ns);
    if (!wasCooled && ns.inCooldown) {
      console.warn(`[MODE B] ⏸ ${ep.name} — entered cooldown (${ns.consecutiveFallback} degraded days)`);
    } else if (wasCooled && !ns.inCooldown) {
      console.log(`[MODE B] ▶ ${ep.name} — recovered to live, cooldown cleared`);
    }

    // Yield のレスポンス実値を観測ログに出す(判断には使わない)
    if (ep.id === "yield-intelligence") {
      console.log(`[MODE B] ${summarizeYield(result.fullData)}`);
    }

    if (result.status === "success") {
      log.totalCostUsdc += result.costUsdc;
      log.totalTxCount += 1;
      console.log(`[MODE B] ✓ ${ep.name} — ${result.responsePeek}`);
    } else if (result.status === "degraded") {
      log.totalCostUsdc += result.costUsdc;
      log.totalDegradedCount += 1;
      console.warn(`[MODE B] ~ ${ep.name} — degraded: ${result.degradedReason}`);
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

  // Persist JIN full responses + transaction log
  saveExternalData(log.results, endpointIdByUrl, date);

  log.durationMs = Date.now() - startMs;
  logRun(log);
  await saveRun(log);
  await sendWebhookSummary(log);

  const ok = log.results.filter((r) => r.status === "success").length;
  const ng = log.results.filter((r) => r.status === "error").length;
  const dg = log.totalDegradedCount;
  console.log(
    `[MODE B] Complete — ${ok} OK, ${dg} degraded, ${ng} errors, $${log.totalCostUsdc.toFixed(3)} USDC, ${Math.round(log.durationMs / 1000)}s`
  );

  return log;
}
