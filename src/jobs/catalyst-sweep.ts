/**
 * Weekly catalyst sweep (buyer side, Solana mainnet).
 *
 * The seller (osd) exposes GET /api/catalyst — a free list of tickers — and
 * GET /api/catalyst/{ticker}, which answers 402 until paid. This job reads the
 * list and calls each ticker, paying exactly 0.0001 USDC on Solana through the
 * existing x402 exact-SVM path. It is the "we settle N per-call payments a week"
 * evidence, not a data pipeline: nothing here decides a trade.
 *
 * Two modes:
 *   run0 (discovery) — pays nothing and cannot: plain fetch, never the paying
 *     client. It reads the list and a small sample of 402s to confirm the wiring
 *     (reachable, 402 returned, amount == 100 units, official USDC mint). The
 *     paid sweep is not run until this passes.
 *   sweep — the paid weekly run. Every payment goes through the catalyst client,
 *     whose policy pays only Solana / official-USDC-mint / exactly-100-unit
 *     requirements, within the weekly cap, all enforced before signing.
 */
import { decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import {
  buildCatalystClient,
  observe,
  priceSummary,
  PRICE_USDC,
  WEEKLY_CAP_USD,
  type CatalystClient,
  type CatalystSpend,
  type ObservedChallenge,
} from "../catalyst/client";
import { allowsCall, isoWeekKey, readWeekSpend, recordWeekSpend } from "../probe/budget";
import {
  appendCsv,
  summarize,
  summarizeBody,
  type CatalystCallRecord,
  type CatalystSummary,
} from "../catalyst/record";

const BASE = () => (process.env.OSD_API_BASE ?? "https://osd.x402jp.com").replace(/\/$/, "");
const LIST_PATH = "/api/catalyst";
/** How many tickers run0 actually pokes with an unpaid 402 read (they are homogeneous). */
const RUN0_SAMPLE = Number(process.env.CATALYST_RUN0_SAMPLE ?? "3");
/** Consecutive errors from the one seller before the whole sweep is abandoned. */
const MAX_CONSECUTIVE_ERRORS = 3;
const DISCOVERY_TIMEOUT_MS = 15_000;

const reader = new x402HTTPClient(new x402Client());

export interface CatalystRunOptions {
  mode: "discovery" | "sweep";
  /** Unpaid fetch. Injected in tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Paying client. Injected in tests; built from env otherwise. */
  client?: CatalystClient | null;
  /** Explicit ticker list. Fetched from {BASE}/api/catalyst otherwise. */
  tickers?: string[];
  /** Already spent this ISO week. Read from the persistent store otherwise. */
  weekSpentUsdc?: number;
  /** Append to the CSV. Off in tests. */
  write?: boolean;
}

export interface CatalystRunReport {
  mode: "discovery" | "sweep";
  week: string;
  tickers: string[];
  records: CatalystCallRecord[];
  summary: CatalystSummary;
  runSpentUsdc: number;
  weekSpentUsdc: number;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Parse the free ticker list, tolerating either shape without inventing tickers:
 *   ["AAPL", "MSFT"]  or  { tickers: [{ ticker: "AAPL" }, ...] }  or  { catalysts: [...] }.
 * Anything that is not a non-empty string ticker is dropped.
 */
export function parseTickerList(body: unknown): string[] {
  const out: string[] = [];
  const push = (t: unknown): void => {
    if (typeof t === "string" && t.trim() !== "") out.push(t.trim());
    else if (t && typeof t === "object") {
      const v = (t as Record<string, unknown>).ticker ?? (t as Record<string, unknown>).symbol;
      if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
    }
  };

  const arrays: unknown[] = [];
  if (Array.isArray(body)) arrays.push(body);
  else if (body && typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v)) arrays.push(v);
    }
  }
  for (const arr of arrays) for (const item of arr as unknown[]) push(item);

  return [...new Set(out)];
}

export async function fetchTickerList(doFetch: typeof globalThis.fetch): Promise<string[]> {
  const res = await doFetch(`${BASE()}${LIST_PATH}`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ticker list HTTP ${res.status}`);
  return parseTickerList(await readBody(res));
}

function tickerUrl(ticker: string): string {
  return `${BASE()}${LIST_PATH}/${encodeURIComponent(ticker)}`;
}

// ── run0 (discovery, no payment) ─────────────────────────────────────────────

async function discoverTicker(
  ticker: string,
  doFetch: typeof globalThis.fetch
): Promise<CatalystCallRecord> {
  const at = new Date().toISOString();
  const startMs = Date.now();
  const base: CatalystCallRecord = { at, ticker, outcome: "error", latencyMs: 0 };

  try {
    const res = await doFetch(tickerUrl(ticker), { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    const payload = await readBody(res);
    base.latencyMs = Date.now() - startMs;
    base.httpStatus = res.status;

    if (res.status === 402) {
      let challenge: ObservedChallenge | undefined;
      try {
        challenge = observe(reader.getPaymentRequiredResponse((n) => res.headers.get(n), payload));
      } catch {
        return { ...base, outcome: "error", reason: "402 だが PAYMENT-REQUIRED を読めない" };
      }
      return {
        ...base,
        outcome: "skipped",
        payable: challenge.payable,
        quotedUnits: challenge.quotedUnits,
        offeredNetworks: challenge.offeredNetworks,
        reason: challenge.payable
          ? `run0: 402 OK・期待要件(Solana/USDC/${PRICE_USDC} USDC)一致(無課金)`
          : `run0: 期待外の支払要件 — 本番では払わない (offered: ${challenge.offeredNetworks.join(" ") || "?"}, units: ${challenge.quotedUnits.join(" ") || "?"})`,
      };
    }
    if (res.ok) {
      return { ...base, outcome: "free", summary: summarizeBody(payload), reason: "無課金で 200" };
    }
    return { ...base, outcome: "error", reason: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ...base,
      latencyMs: Date.now() - startMs,
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── sweep (paid) ─────────────────────────────────────────────────────────────

async function sweepTicker(
  ticker: string,
  client: CatalystClient,
  spend: CatalystSpend
): Promise<CatalystCallRecord> {
  const at = new Date().toISOString();
  const startMs = Date.now();
  const base: CatalystCallRecord = { at, ticker, outcome: "error", latencyMs: 0 };

  client.takeChallenge(); // 前回の残りを持ち越さない
  try {
    const res = await client.fetch(tickerUrl(ticker));
    const challenge = client.takeChallenge();
    const payload = await readBody(res);
    base.latencyMs = Date.now() - startMs;
    base.httpStatus = res.status;
    base.quotedUnits = challenge?.quotedUnits;
    base.offeredNetworks = challenge?.offeredNetworks;

    const settleHeader =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    if (settleHeader) {
      try {
        const settle = decodePaymentResponseHeader(settleHeader);
        base.txHash = settle.transaction;
        base.actualUsdc =
          settle.amount !== undefined ? Number(BigInt(settle.amount)) / 1e6 : PRICE_USDC;
      } catch {
        base.reason = "PAYMENT-RESPONSE を読めない";
        base.actualUsdc = PRICE_USDC; // 決済は通ったが額が読めない: 期待額で計上
      }
    }

    if (!res.ok) {
      return { ...base, outcome: "error", reason: `HTTP ${res.status}`, summary: summarizeBody(payload) };
    }
    return { ...base, outcome: settleHeader ? "paid" : "free", summary: summarizeBody(payload) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const challenge = client.takeChallenge();
    base.latencyMs = Date.now() - startMs;
    base.quotedUnits = challenge?.quotedUnits;
    base.offeredNetworks = challenge?.offeredNetworks;

    // The policy dropping every requirement (expected-requirement mismatch, or
    // the weekly cap) makes selection fail before signing — that is a refusal,
    // not a payment error, so it is recorded as skipped and costs nothing.
    if (challenge && !challenge.payable) {
      return {
        ...base,
        outcome: "skipped",
        reason: `期待外の支払要件のため未払い (offered: ${challenge.offeredNetworks.join(" ") || "?"}, units: ${challenge.quotedUnits.join(" ") || "?"})`,
      };
    }
    if (
      challenge &&
      !allowsCall(PRICE_USDC, spend.run, spend.week, {
        perRun: WEEKLY_CAP_USD,
        perWeek: WEEKLY_CAP_USD,
      }).allowed
    ) {
      return { ...base, outcome: "skipped", reason: "週次予算により未払い" };
    }
    return { ...base, outcome: "error", reason: msg };
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function runCatalystSweep(options: CatalystRunOptions): Promise<CatalystRunReport> {
  const week = isoWeekKey();
  const weekSpentBefore = options.weekSpentUsdc ?? (await readWeekSpend("catalyst", week));
  const spend: CatalystSpend = { run: 0, week: weekSpentBefore };
  const doFetch = options.fetchImpl ?? fetch;

  let tickers = options.tickers;
  if (!tickers) {
    try {
      tickers = await fetchTickerList(doFetch);
    } catch (err) {
      console.error(`[CATALYST] ticker list fetch failed: ${String(err)}`);
      tickers = [];
    }
  }
  console.log(
    `[CATALYST] ${options.mode} — ${tickers.length} tickers / ${week} / 消費済み $${weekSpentBefore.toFixed(4)} / 単価 ${priceSummary()} / 週上限 $${WEEKLY_CAP_USD}`
  );

  const records: CatalystCallRecord[] = [];

  if (options.mode === "discovery") {
    // Homogeneous sellers: poke a sample to confirm wiring, don't read 200 identical 402s.
    const sample = tickers.slice(0, Math.max(1, RUN0_SAMPLE));
    for (const ticker of sample) records.push(await discoverTicker(ticker, doFetch));
    if (tickers.length > sample.length) {
      console.log(`[CATALYST] run0: ${sample.length}/${tickers.length} 件だけ 402 確認(残りは同型)`);
    }
  } else {
    const client = options.client !== undefined ? options.client : await buildCatalystClient(spend);
    if (!client) {
      throw new Error(
        "Solana signer 未設定: SOLANA_SIGNER_BACKEND=circle + CIRCLE_SOLANA_* か SOLANA_PRIVATE_KEY が必要 " +
          "(鍵は Circle DCW が保持。生鍵は env に置かない)"
      );
    }
    console.log(`[CATALYST] paying wallet: ${client.walletAddress}`);

    let consecutiveErrors = 0;
    for (const ticker of tickers) {
      if (spend.week >= WEEKLY_CAP_USD) {
        console.warn(`[CATALYST] 週上限到達で中断 (week $${spend.week.toFixed(4)})`);
        break;
      }
      const record = await sweepTicker(ticker, client, spend);
      records.push(record);

      if (record.outcome === "paid" && record.actualUsdc !== undefined) {
        spend.run += record.actualUsdc;
        spend.week += record.actualUsdc;
        await recordWeekSpend("catalyst", record.actualUsdc, { target: "catalyst", path: ticker });
      }

      consecutiveErrors = record.outcome === "error" ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn(`[CATALYST] ${MAX_CONSECUTIVE_ERRORS} 回連続エラー — sweep 中断(売り手側の障害とみなす)`);
        break;
      }
    }
  }

  const summary = summarize(records);
  if (options.write !== false) appendCsv(records);

  console.log(
    `[CATALYST] 完了 — ${summary.tickers} 件 (paid ${summary.paid}, free ${summary.free}, ` +
      `skip ${summary.skipped}, err ${summary.errors}) 実費 $${summary.totalUsdc.toFixed(6)}` +
      `${summary.sampleTx ? ` / 代表tx ${summary.sampleTx}` : ""} / 今週 $${spend.week.toFixed(6)}`
  );

  return { mode: options.mode, week, tickers, records, summary, runSpentUsdc: spend.run, weekSpentUsdc: spend.week };
}
