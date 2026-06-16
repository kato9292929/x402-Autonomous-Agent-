import * as fs from "fs";
import * as path from "path";
import { ENDPOINTS_MODE_B } from "../config";
import { callEndpoint, getConsecutiveFailures } from "../caller";
import { logRun } from "../logger";
import { sendWebhookSummary } from "../notify";
import type { EndpointResult, RunLog } from "../types";

const FAILURE_ALERT_THRESHOLD = 3;
const EXTERNAL_IDS = new Set([
  "birdeye-ohlcv",
  "perplexity-research",
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
      "birdeye-ohlcv": "birdeye",
      "perplexity-research": "perplexity",
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

export async function runModeB(): Promise<void> {
  const startMs = Date.now();
  const date = todayDate();
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

  // Map URL → endpoint id for post-loop lookup
  const endpointIdByUrl = new Map(ENDPOINTS_MODE_B.map((ep) => [ep.url, ep.id]));

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

  // Persist Birdeye / Perplexity full responses + transaction log
  saveExternalData(log.results, endpointIdByUrl, date);

  log.durationMs = Date.now() - startMs;
  logRun(log);
  await sendWebhookSummary(log);

  const ok = log.results.filter((r) => r.status === "success").length;
  const ng = log.results.filter((r) => r.status === "error").length;
  console.log(
    `[MODE B] Complete — ${ok} OK, ${ng} errors, $${log.totalCostUsdc.toFixed(3)} USDC, ${Math.round(log.durationMs / 1000)}s`
  );
}
