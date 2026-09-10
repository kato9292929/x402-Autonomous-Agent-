/**
 * Last weekly sweep per surface, for the dashboard headline.
 *
 * The sweep (catalyst / EDINET) settles ~200 per-call payments a week — the
 * "毎週N社 per-call" evidence. That belongs at the top of the card, so each
 * completed sweep records a compact summary here (Upstash, with a local
 * fallback). One key per surface, overwritten each week.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "./upstash-rest";

export interface SweepSummary {
  surface: string;
  /** ISO timestamp the sweep finished. */
  at: string;
  /** ISO week key. */
  week: string;
  /** Number of settled per-call payments. */
  settlements: number;
  /** Total USDC spent in the sweep. */
  totalUsdc: number;
  /** A representative settlement tx (Solscan). */
  sampleTx?: string;
}

const redisKey = (surface: string) => `sweep_last:${surface}`;
const localFile = () => path.join(process.cwd(), "data", "sweeps", "last.json");

function readLocalAll(): Record<string, SweepSummary> {
  try {
    return JSON.parse(fs.readFileSync(localFile(), "utf-8")) as Record<string, SweepSummary>;
  } catch {
    return {};
  }
}

export async function saveSweepSummary(summary: SweepSummary): Promise<void> {
  if (upstashConfigured()) {
    try {
      await upstashCommand(["SET", redisKey(summary.surface), JSON.stringify(summary)]);
    } catch (err) {
      console.warn(`[SWEEP] summary write failed for ${summary.surface}: ${String(err)}`);
    }
  }
  try {
    const all = readLocalAll();
    all[summary.surface] = summary;
    fs.mkdirSync(path.dirname(localFile()), { recursive: true });
    fs.writeFileSync(localFile(), JSON.stringify(all), "utf-8");
  } catch (err) {
    console.warn(`[SWEEP] summary local write failed for ${summary.surface}: ${String(err)}`);
  }
}

/** All surfaces' latest sweep summaries, newest first. */
export async function loadSweepSummaries(surfaces = ["edinet", "catalyst"]): Promise<SweepSummary[]> {
  const out: SweepSummary[] = [];
  for (const surface of surfaces) {
    let s: SweepSummary | undefined;
    if (upstashConfigured()) {
      try {
        const raw = await upstashCommand<string | null>(["GET", redisKey(surface)]);
        if (raw) s = JSON.parse(raw) as SweepSummary;
      } catch (err) {
        console.warn(`[SWEEP] summary read failed for ${surface}: ${String(err)}`);
      }
    }
    if (!s) s = readLocalAll()[surface];
    if (s) out.push(s);
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
