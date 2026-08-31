/**
 * What the probe writes down, per call.
 *
 * Every field is observed: the quote comes from the seller's 402, the actual
 * charge from the settlement response, the chain from the requirement that was
 * paid. Nothing is back-filled from the published price list — §9 exists because
 * the published price and the real charge are expected to disagree, and a record
 * that quietly copies the price list cannot show that.
 *
 * `quality` is left empty on purpose: the 5-point score is a human judgement and
 * the agent does not invent one.
 */
import * as fs from "fs";
import * as path from "path";
import { summarizeSample } from "../store/samples";

export type ProbeOutcome =
  | "paid" // 課金あり、レスポンス取得
  | "free" // 402 が返らず 200(無課金)
  | "skipped" // 予算・チェーン非対応などで叩かなかった
  | "error"; // 到達不能 / HTTP エラー / 決済失敗

export interface ProbeCallRecord {
  at: string;
  target: string;
  path: string;
  method: string;
  /** Quoted by the seller's 402, in USDC. Undefined when no 402 was seen. */
  quotedUsdc?: number;
  /** Actually settled, in USDC. Undefined when nothing was paid. */
  actualUsdc?: number;
  latencyMs: number;
  httpStatus?: number;
  /** Networks the seller offered on the 402. */
  offeredNetworks?: string[];
  /** The network the payment actually settled on. */
  chain?: string;
  txHash?: string;
  /** A few figures lifted verbatim out of the response. */
  summary?: string;
  outcome: ProbeOutcome;
  reason?: string;
}

export const CSV_HEADER = [
  "at",
  "target",
  "path",
  "method",
  "outcome",
  "quoted_usdc",
  "actual_usdc",
  "latency_ms",
  "http",
  "offered_networks",
  "chain",
  "tx",
  "summary",
  "reason",
  "quality", // 人が後から 1-5 を書き込む列。エージェントは埋めない。
].join(",");

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvRow(r: ProbeCallRecord): string {
  return [
    r.at,
    r.target,
    r.path,
    r.method,
    r.outcome,
    r.quotedUsdc,
    r.actualUsdc,
    r.latencyMs,
    r.httpStatus,
    r.offeredNetworks?.join(" "),
    r.chain,
    r.txHash,
    r.summary,
    r.reason,
    "", // quality
  ]
    .map(csvCell)
    .join(",");
}

export function csvPath(): string {
  return path.join(process.cwd(), "data", "probe", "probe-calls.csv");
}

/** Append rows, writing the header once when the file is new. Append-only. */
export function appendCsv(records: ProbeCallRecord[], file = csvPath()): void {
  if (records.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = fs.existsSync(file) ? "" : CSV_HEADER + "\n";
  fs.appendFileSync(file, header + records.map(toCsvRow).join("\n") + "\n", "utf-8");
}

export interface TargetSummary {
  target: string;
  calls: number;
  paidCalls: number;
  /** Sum of what was actually charged. */
  totalUsdc: number;
  /** Measured per-call: totalUsdc / paidCalls. Undefined when nothing was paid. */
  measuredPerCallUsdc?: number;
  /** Share of attempted calls that returned a usable response. */
  successRate: number;
  skipped: number;
  errors: number;
}

/**
 * Per-seller weekly view, derived from the call records.
 *
 * Derived rather than stored: a summary kept alongside the rows is a second
 * source that can disagree with them.
 */
export function summarize(records: ProbeCallRecord[]): TargetSummary[] {
  const byTarget = new Map<string, ProbeCallRecord[]>();
  for (const r of records) {
    const list = byTarget.get(r.target) ?? [];
    list.push(r);
    byTarget.set(r.target, list);
  }

  return [...byTarget.entries()].map(([target, rows]) => {
    const paid = rows.filter((r) => r.outcome === "paid");
    const attempted = rows.filter((r) => r.outcome !== "skipped");
    const ok = rows.filter((r) => r.outcome === "paid" || r.outcome === "free");
    const totalUsdc = paid.reduce((s, r) => s + (r.actualUsdc ?? 0), 0);
    return {
      target,
      calls: rows.length,
      paidCalls: paid.length,
      totalUsdc,
      measuredPerCallUsdc: paid.length > 0 ? totalUsdc / paid.length : undefined,
      successRate: attempted.length > 0 ? ok.length / attempted.length : 0,
      skipped: rows.filter((r) => r.outcome === "skipped").length,
      errors: rows.filter((r) => r.outcome === "error").length,
    };
  });
}

/** Short, verbatim excerpt of a response body for the record. */
export function summarizeBody(body: unknown): string | undefined {
  const highlights = summarizeSample(body, 4);
  if (highlights.length > 0) return highlights.join(" | ");
  if (typeof body === "string" && body.length > 0) return body.slice(0, 120);
  return undefined;
}
