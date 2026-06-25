/**
 * Append-only consumption log for osd calls: { endpoint, price_usd, network,
 * tx_or_settlement_ref, ts }. Written to a local JSONL file always (audit /
 * local dev) and pushed to an Upstash list when configured — mirroring the
 * Mode A decision-store dual-write.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";
import type { ConsumptionLogEntry } from "./types";

const FILE_PATH = path.join(process.cwd(), "data", "osd", "consumption-log.jsonl");
const LIST_KEY = "osd_consumption_log";

function appendFile(entry: ConsumptionLogEntry): void {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.appendFileSync(FILE_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

export async function logConsumption(entry: ConsumptionLogEntry): Promise<void> {
  appendFile(entry);
  console.log(
    `[OSD] consume ${entry.endpoint} $${entry.price_usd.toFixed(2)} ${entry.network} ` +
      `ref=${entry.tx_or_settlement_ref ?? "-"} (HTTP ${entry.status})`
  );
  if (upstashConfigured()) {
    try {
      await upstashCommand(["RPUSH", LIST_KEY, JSON.stringify(entry)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[OSD] Upstash RPUSH consumption failed: ${msg}`);
    }
  }
}
