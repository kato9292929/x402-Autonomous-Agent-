/**
 * Per-company settlements of one weekly sweep, durably.
 *
 * The summary (count / total / one tx) is not enough — the point of the sweep is
 * that every one of ~200 companies got its own on-chain per-call payment, and
 * that has to be visible company-by-company. So each sweep stores its full list
 * of settlements, keyed by surface + ISO week, in Upstash (a local file is only
 * a dev fallback; Railway's disk resets on redeploy). One sweep is the complete
 * set for its week, so a re-run overwrites rather than appends.
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "./upstash-rest";

export interface SweepItem {
  /** Ticker / EDINET code that was paid for. */
  ticker: string;
  /** Company name, when known. Absent for on-chain-only backfill. */
  name?: string;
  /** USDC actually settled. */
  amountUsdc: number;
  /** Settlement tx (Solscan). */
  tx?: string;
  at: string;

  // ── 財務ハイライトの差し替え口 (osd #51 EDINET 実財務スキーマ) ────────────────
  // 表示単位は百万円に統一。EDINET は生JPY を jpyToMillions() で ÷1e6 して入れ、
  // catalyst は既に百万円なのでそのまま入れる(単位整合)。
  // 区分A ではインターフェースのみ用意し、値は埋めない(区分B の実 inspect 後に配線)。
  // 実値未確認の間に表示するダミーには必ず「未検証」ラベルを付ける(禁止事項: ラベル運用)。
  /** 売上高 (百万円)。null=取得不可、undefined=未取り込み。 */
  salesM?: number | null;
  /** 営業利益 (百万円)。 */
  operatingIncomeM?: number | null;
  /** false = 書類は特定できたが財務未取得(空を財務に見せない)。 */
  financialsAvailable?: boolean;
}

const redisKey = (surface: string, week: string) => `sweep_items:${surface}:${week}`;
const localFile = (surface: string, week: string) =>
  path.join(process.cwd(), "data", "sweeps", `${surface}-${week}.json`);

/** Replace the week's settlement list for a surface. */
export async function saveSweepItems(
  surface: string,
  week: string,
  items: SweepItem[]
): Promise<void> {
  const value = JSON.stringify(items);
  if (upstashConfigured()) {
    try {
      await upstashCommand(["SET", redisKey(surface, week), value]);
    } catch (err) {
      console.warn(`[SWEEP-ITEMS] write failed for ${surface}/${week}: ${String(err)}`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(localFile(surface, week)), { recursive: true });
    fs.writeFileSync(localFile(surface, week), value, "utf-8");
  } catch (err) {
    console.warn(`[SWEEP-ITEMS] local write failed for ${surface}/${week}: ${String(err)}`);
  }
}

async function readAll(surface: string, week: string): Promise<SweepItem[]> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string | null>(["GET", redisKey(surface, week)]);
      if (raw) return JSON.parse(raw) as SweepItem[];
      return [];
    } catch (err) {
      console.warn(`[SWEEP-ITEMS] read failed for ${surface}/${week}: ${String(err)}`);
    }
  }
  try {
    return JSON.parse(fs.readFileSync(localFile(surface, week), "utf-8")) as SweepItem[];
  } catch {
    return [];
  }
}

export interface SweepItemsPage {
  items: SweepItem[];
  total: number;
  offset: number;
  limit: number;
}

/** A page of a sweep's settlements. */
export async function loadSweepItems(
  surface: string,
  week: string,
  offset = 0,
  limit = 50
): Promise<SweepItemsPage> {
  const all = await readAll(surface, week);
  const from = Math.max(0, offset);
  const size = Math.min(500, Math.max(1, limit));
  return { items: all.slice(from, from + size), total: all.length, offset: from, limit: size };
}
