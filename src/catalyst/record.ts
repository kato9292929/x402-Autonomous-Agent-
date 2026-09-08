/**
 * What the catalyst sweep writes down, per ticker.
 *
 * The quote comes from the seller's 402 and the charge from the settlement
 * response — never copied from the configured price. §6 of the runbook wants
 * this as the "we settle N per-call payments a week" evidence, so the tx hash
 * (Solscan) is the point, and unknown values stay empty rather than being
 * filled with the expected amount.
 */
import * as fs from "fs";
import * as path from "path";
import { summarizeBody } from "../probe/record";

export type CatalystOutcome =
  | "paid" // 課金あり・データ取得
  | "free" // 402 が返らず 200(無料枠)
  | "skipped" // 予算・期待外要件などで叩かなかった/払わなかった
  | "error"; // 到達不能 / HTTP エラー / 決済失敗

export interface CatalystCallRecord {
  at: string;
  ticker: string;
  outcome: CatalystOutcome;
  /** Amounts quoted on Solana requirements (base units), verbatim. */
  quotedUnits?: string[];
  /** Actually settled, in USDC. */
  actualUsdc?: number;
  latencyMs: number;
  httpStatus?: number;
  offeredNetworks?: string[];
  txHash?: string;
  summary?: string;
  reason?: string;
  /**
   * Whether the 402 offered a requirement we would pay (Solana / USDC / exact
   * PRICE_UNITS). In-memory only — the autopilot reads it to pick a smoke-test
   * ticker without parsing the Japanese `reason` string. Not a CSV column.
   */
  payable?: boolean;
}

export const CSV_HEADER = [
  "at",
  "ticker",
  "outcome",
  "quoted_units",
  "actual_usdc",
  "latency_ms",
  "http",
  "offered_networks",
  "tx",
  "summary",
  "reason",
].join(",");

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvRow(r: CatalystCallRecord): string {
  return [
    r.at,
    r.ticker,
    r.outcome,
    r.quotedUnits?.join(" "),
    r.actualUsdc,
    r.latencyMs,
    r.httpStatus,
    r.offeredNetworks?.join(" "),
    r.txHash,
    r.summary,
    r.reason,
  ]
    .map(csvCell)
    .join(",");
}

export function csvPath(): string {
  return path.join(process.cwd(), "data", "catalyst", "catalyst-calls.csv");
}

export function appendCsv(records: CatalystCallRecord[], file = csvPath()): void {
  if (records.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = fs.existsSync(file) ? "" : CSV_HEADER + "\n";
  fs.appendFileSync(file, header + records.map(toCsvRow).join("\n") + "\n", "utf-8");
}

export interface CatalystSummary {
  tickers: number;
  paid: number;
  free: number;
  skipped: number;
  errors: number;
  totalUsdc: number;
  /** Representative settlement tx, for the log / Solscan. */
  sampleTx?: string;
}

export function summarize(records: CatalystCallRecord[]): CatalystSummary {
  const paid = records.filter((r) => r.outcome === "paid");
  return {
    tickers: records.length,
    paid: paid.length,
    free: records.filter((r) => r.outcome === "free").length,
    skipped: records.filter((r) => r.outcome === "skipped").length,
    errors: records.filter((r) => r.outcome === "error").length,
    totalUsdc: paid.reduce((s, r) => s + (r.actualUsdc ?? 0), 0),
    sampleTx: paid.find((r) => r.txHash)?.txHash,
  };
}

export { summarizeBody };
