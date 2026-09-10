/**
 * Backfill the per-company settlements of the EDINET sweep that already ran
 * (2026-09-10, 197 payments) before the per-item store existed, so the hero
 * lists every company. Two sources, in order — nothing is fabricated:
 *
 *   1. data/edinet/edinet-calls.csv, if it survived on disk: ticker → tx → amount
 *      for every paid row. This gives the full ticker↔tx mapping.
 *   2. Otherwise on-chain: the payer's USDC transfers in the sweep window are
 *      real, but carry no ticker, so they are stored tx-only (ticker blank). A
 *      dedicated Solana RPC (SOLANA_RPC_URL) is required.
 *
 * If neither yields the settlements, it says so rather than inventing rows — the
 * clean alternative is to re-run `npm run edinet:sweep`, which now persists all
 * 197 with tickers.
 *
 *   npm run backfill:edinet-items
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { saveSweepItems, loadSweepItems, type SweepItem } from "../store/sweep-items";
import { saveSweepSummary } from "../store/sweep-summary";

const WEEK = process.env.EDINET_BACKFILL_WEEK ?? "2026-W37";
const PAYER = process.env.CIRCLE_SOLANA_WALLET_ADDRESS ?? "7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY";
const WINDOW_START = Date.parse("2026-09-10T00:00:00Z") / 1000;
const WINDOW_END = Date.parse("2026-09-10T00:10:00Z") / 1000;

/** Parse a CSV line respecting quoted cells. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function fromCsv(): SweepItem[] | null {
  const file = path.join(process.cwd(), "data", "edinet", "edinet-calls.csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  if (lines.length < 2) return null;
  const header = parseCsvLine(lines[0]);
  const col = (n: string) => header.indexOf(n);
  const [iTicker, iOutcome, iActual, iTx, iAt] = [col("ticker"), col("outcome"), col("actual_usdc"), col("tx"), col("at")];
  const items: SweepItem[] = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c[iOutcome] !== "paid") continue;
    const tx = c[iTx]?.trim();
    if (!tx) continue;
    items.push({
      ticker: c[iTicker]?.trim() ?? "",
      amountUsdc: Number(c[iActual]) || 0.001,
      tx,
      at: c[iAt]?.trim() || "2026-09-10T00:06:00Z",
    });
  }
  return items.length ? items : null;
}

interface RpcSig { signature: string; blockTime?: number | null }

async function fromChain(): Promise<SweepItem[] | null> {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) {
    console.warn("[BACKFILL] no SOLANA_RPC_URL — cannot read the payer's transfers on-chain");
    return null;
  }
  const collected: SweepItem[] = [];
  let before: string | undefined;
  // Page back through the payer's recent signatures until we pass the window.
  for (let page = 0; page < 30; page++) {
    const body = {
      jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
      params: [PAYER, { limit: 1000, ...(before ? { before } : {}) }],
    };
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { result?: RpcSig[] };
    const sigs = json.result ?? [];
    if (!sigs.length) break;
    for (const s of sigs) {
      const t = s.blockTime ?? 0;
      if (t >= WINDOW_START && t <= WINDOW_END) {
        collected.push({ ticker: "", amountUsdc: 0.001, tx: s.signature, at: new Date(t * 1000).toISOString() });
      }
    }
    const oldest = sigs[sigs.length - 1];
    if ((oldest.blockTime ?? 0) < WINDOW_START) break; // paged past the window
    before = oldest.signature;
  }
  // Store newest→oldest as the sweep order (tx-only, no ticker — not fabricated).
  return collected.length ? collected.reverse() : null;
}

async function main(): Promise<void> {
  let items = fromCsv();
  if (items) {
    console.log(`[BACKFILL] CSV に ${items.length} 件の paid 決済(ticker↔tx)を発見`);
  } else {
    console.log("[BACKFILL] CSV が無い/空 — オンチェーンで payer の転送を取得(ticker無し)");
    items = await fromChain();
  }
  if (!items || !items.length) {
    console.error(
      "[BACKFILL] 決済を取得できませんでした。CSV は消えている可能性が高いです。" +
        "最も確実なのは `npm run edinet:sweep` の再実行(全197件を ticker 付きで永続化、$0.197)。"
    );
    process.exit(1);
  }
  await saveSweepItems("edinet", WEEK, items);
  // Also (re)write the headline summary, so /api/sweeps knows this week exists
  // and the section/card show it even without a separate seed step.
  await saveSweepSummary({
    surface: "edinet",
    at: items[items.length - 1]?.at ?? "2026-09-10T00:06:29.310Z",
    week: WEEK,
    settlements: items.length,
    totalUsdc: items.reduce((s, i) => s + (i.amountUsdc || 0), 0),
    sampleTx: items.find((i) => i.tx)?.tx,
  });
  const page = await loadSweepItems("edinet", WEEK, 0, 3);
  console.log(`[BACKFILL] 保存: edinet/${WEEK} — ${page.total} 件。先頭3件:`);
  console.log(JSON.stringify(page.items, null, 2));
  const withTicker = items.filter((i) => i.ticker).length;
  console.log(`[BACKFILL] ticker 付き ${withTicker} / ${items.length}(tx のみ ${items.length - withTicker})`);
}

main().catch((err: unknown) => {
  console.error("[BACKFILL] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
