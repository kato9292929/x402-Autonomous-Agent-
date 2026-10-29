/**
 * Persistence for Phase A catalysts that AA submits to osd.
 *
 * Reuses the existing Upstash REST pattern (env-gated by
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN); falls back to a local
 * JSON file for local dev when Upstash is absent — same approach as the Mode A
 * decision-store and the World ID stores.
 *
 *   osd_catalyst:{catalyst_id}   → JSON CatalystRecord
 *   osd_catalysts_index          → SET of catalyst_ids (for enumeration)
 *   osd_catalyst_seed:{seedKey}  → catalyst_id (dedupe seed submissions)
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";
import type { CatalystRecord } from "./types";

const FILE_PATH = path.join(process.cwd(), "data", "osd", "catalysts.json");
const catalystKey = (id: string): string => `osd_catalyst:${id}`;
const seedKey = (key: string): string => `osd_catalyst_seed:${key}`;
const INDEX = "osd_catalysts_index";

interface FileShape {
  catalysts: CatalystRecord[];
}

function loadFile(): FileShape {
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")) as FileShape;
  } catch {
    return { catalysts: [] };
  }
}

function saveFile(data: FileShape): void {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Insert or overwrite a catalyst record. */
export async function saveCatalyst(rec: CatalystRecord): Promise<void> {
  if (upstashConfigured()) {
    await upstashCommand(["SET", catalystKey(rec.catalyst_id), JSON.stringify(rec)]);
    await upstashCommand(["SADD", INDEX, rec.catalyst_id]);
    if (rec.seed_key) {
      await upstashCommand(["SET", seedKey(rec.seed_key), rec.catalyst_id]);
    }
    return;
  }
  const data = loadFile();
  const idx = data.catalysts.findIndex((c) => c.catalyst_id === rec.catalyst_id);
  if (idx >= 0) data.catalysts[idx] = rec;
  else data.catalysts.push(rec);
  saveFile(data);
}

export async function listCatalysts(): Promise<CatalystRecord[]> {
  if (upstashConfigured()) {
    const ids = (await upstashCommand<string[] | null>(["SMEMBERS", INDEX])) ?? [];
    const out: CatalystRecord[] = [];
    for (const id of ids) {
      const raw = await upstashCommand<string | null>(["GET", catalystKey(id)]);
      if (raw) out.push(JSON.parse(raw) as CatalystRecord);
    }
    return out;
  }
  return loadFile().catalysts;
}

/** Has this seed already been submitted (so we don't resubmit it)? */
export async function isSeedSubmitted(key: string): Promise<boolean> {
  if (upstashConfigured()) {
    const id = await upstashCommand<string | null>(["GET", seedKey(key)]);
    return Boolean(id);
  }
  return loadFile().catalysts.some((c) => c.seed_key === key);
}
