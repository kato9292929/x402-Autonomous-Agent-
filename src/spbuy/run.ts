/**
 * The daily Seller Probe–driven purchase of external x402 endpoints.
 *
 * Runs with the 06:00 JST daily run, after the agent's own purchases. Each run:
 *   1. picks the day's targets afresh from Seller Probe's per-endpoint verdicts
 *      (select.ts);
 *   2. for each, rebuilds the exact request Seller Probe bought with (method,
 *      URL with its query, body; idempotency keys and nonces made fresh);
 *   3. sends it unpaid first and pays only if that answers 402, offers a leg
 *      the agent can pay at ≤ $0.01, and its payTo is not ours;
 *   4. pays with the existing x402 client, within $0.01 a call and the daily
 *      budget (SP_BUY_DAILY_USD, default $0.30);
 *   5. checks the body with Seller Probe's five content checks (judge.ts) and
 *      records the result in Seller Probe's own record shape, so it can be
 *      handed back later.
 * An endpoint whose bodies keep failing the checks is cooled down with the
 * existing Mode B cooldown (3 days, then a probe every 3 days).
 */
import { randomUUID, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { priceOf } from "../payment-guard";
import { buildProbeClient, isSignableLeg, type ProbeClient } from "../probe/client";
import { readWeekSpend, recordWeekSpend } from "../probe/budget";
import { upstashCommand, upstashConfigured } from "../store/upstash-rest";
import { decideCall, loadCooldown, nextState, saveCooldown } from "../modes/fallback-cooldown";
import { contentChecks, outputFromPaymentRequired, type Check } from "./judge";
import { findSettlement as findSettlementOnChain, sentPaymentFromHeader } from "./settle-search";
import {
  loadSources,
  OWN_PAYTO,
  PAYABLE_NETWORKS,
  PER_CALL_CAP_USD,
  selectTargets,
  type CuratedItem,
  type CatalogEntry,
  type Refusal,
  type Target,
} from "./select";

export const DAILY_CAP_USD = () => {
  const v = Number(process.env.SP_BUY_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0.3;
};
export const spBuyEnabled = () => process.env.SP_BUY_ENABLED !== "false";

/** Seller Probe's verdicts, as its judge names them; the subset this path can reach. */
export type Verdict =
  | "as_described"
  | "not_as_described"
  | "input_mismatch"
  | "paid_then_rejected"
  | "paid_not_delivered"
  | "not_settled"
  | "not_bought";

export const VERDICT_LABELS: Record<Verdict, string> = {
  as_described: "納品・説明どおり",
  not_as_described: "納品・説明と違う",
  input_mismatch: "支払いなしで 402 が返らない(払わず)",
  paid_then_rejected: "受け付けない要求で先に決済した",
  paid_not_delivered: "送金したが届かなかった",
  not_settled: "送金されず届かなかった",
  not_bought: "買わなかった",
};

/** One purchase, in the shape of Seller Probe's curated record (plus why it was picked). */
export interface SpBuyRecord {
  at: string;
  path: "seller-probe-daily";
  curated_id: string;
  operator: string;
  host: string;
  url: string;
  category: string;
  price_usd: number;
  /** Why it was chosen. */
  selection: Target["reason"];
  request: { method: string; url: string; body: unknown; values: Array<{ in: string; name: string; value: unknown; from: string }> };
  http_status: number | null;
  /** The cheapest leg the unpaid 402 offered that the agent can pay. */
  quoted_usd: number | null;
  tx: string | null;
  /** "header" when the seller's settlement header named it; "onchain_search" when it was found on chain. */
  tx_source: "header" | "onchain_search" | null;
  network: string | null;
  amount_usd: number | null;
  response_sha256: string | null;
  response_bytes: number | null;
  /** First 300 characters of the body (for the card), and 500 when a check failed. */
  summary: string | null;
  body_head: string | null;
  checks: Check[] | null;
  /** When the paid call did not answer 200: the 402's error field and the body's first 300 characters. */
  error_body: string | null;
  verdict: Verdict;
  verdict_reason: string;
  /** Seller Probe said 説明どおり; this purchase did not get that. */
  disagrees: boolean;
  latency_ms: number;
}

export interface SpBuyRun {
  at: string;
  date: string;
  dryRun: boolean;
  source: { curatedGeneratedAt: string | null; items: number };
  dailyCapUsd: number;
  spentUsd: number;
  targets: number;
  records: SpBuyRecord[];
  refused: Refusal[];
  /** Targets not called today: cooled down or over the day's budget. */
  notCalled: Array<{ id: string; host: string; url: string; reason: string }>;
}

const FRESH = /idempot|request_?key|nonce|request_?id|client_?ref/i;

/** Seller Probe's request, with idempotency keys and nonces made fresh. */
export function rebuildRequest(t: Target): SpBuyRecord["request"] {
  const values = (t.request.values ?? []).map((v) => ({ ...v }));
  const url = new URL(t.request.url);
  for (const [k] of url.searchParams) {
    if (FRESH.test(k)) {
      const v = `aa-${randomUUID()}`;
      url.searchParams.set(k, v);
      values.push({ in: "query", name: k, value: v, from: "fresh per request" });
    }
  }
  let body: unknown = t.request.body ?? null;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = { ...(body as Record<string, unknown>) };
    for (const k of Object.keys(b))
      if (FRESH.test(k)) {
        b[k] = `aa-${randomUUID()}`;
        values.push({ in: "body", name: k, value: b[k], from: "fresh per request" });
      }
    body = b;
  }
  return { method: t.request.method.toUpperCase(), url: url.toString(), body, values };
}

const init = (req: SpBuyRecord["request"]): RequestInit => ({
  method: req.method,
  ...(req.body !== null && req.body !== undefined && req.method !== "GET" && req.method !== "HEAD"
    ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) }
    : {}),
});

const reader = new x402HTTPClient(new x402Client());

/** The unpaid answer to the request: 402 and what it offers, or why not to pay. */
async function preflight(
  req: SpBuyRecord["request"],
  t: Target,
  fetchImpl: typeof fetch
): Promise<
  | { ok: true; quoted: number; network: string; output: ReturnType<typeof outputFromPaymentRequired> }
  | { ok: false; status: number | null; verdict: Verdict; reason: string }
> {
  let res: Response;
  try {
    res = await fetchImpl(req.url, { ...init(req), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { ok: false, status: null, verdict: "not_bought", reason: `支払いなしの要求が失敗: ${String(err).slice(0, 120)}` };
  }
  const text = await res.text().catch(() => "");
  if (res.status !== 402) {
    return { ok: false, status: res.status, verdict: "input_mismatch", reason: `HTTP ${res.status} on ${req.method}, not 402 — 払わない` };
  }
  let doc: any;
  try {
    doc = reader.getPaymentRequiredResponse((n) => res.headers.get(n), text ? JSON.parse(text) : undefined);
  } catch {
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, status: 402, verdict: "not_bought", reason: "402 を読めない" };
    }
  }
  const accepts: PaymentRequirements[] = doc?.accepts ?? [];
  const own = accepts.find((a) => OWN_PAYTO.has(String((a as any).payTo ?? "").toLowerCase()));
  if (own) return { ok: false, status: 402, verdict: "not_bought", reason: "受取先が自社(payTo)" };
  const legs = accepts
    .filter((a) => PAYABLE_NETWORKS.has(String((a as any).network)) && isSignableLeg(a) && (a as any).scheme === "exact")
    .map((a) => ({ network: String((a as any).network), price: priceOf(a) }))
    .filter((l): l is { network: string; price: number } => l.price !== undefined && l.price > 0);
  if (!legs.length) return { ok: false, status: 402, verdict: "not_bought", reason: "払えるネットワークの提示がない" };
  // Prefer the network Seller Probe settled on; else the cheapest.
  const same = legs.filter((l) => l.network === t.network);
  const leg = (same.length ? same : legs).sort((a, b) => a.price - b.price)[0];
  if (leg.price > PER_CALL_CAP_USD) {
    return { ok: false, status: 402, verdict: "not_bought", reason: `提示額 $${leg.price} が上限 $${PER_CALL_CAP_USD} を超える` };
  }
  return { ok: true, quoted: leg.price, network: leg.network, output: outputFromPaymentRequired(doc) };
}

/** Seller Probe's verdict for a paid call, from what came back. */
export function verdictOf(a: { status: number; tx: string | null; bodyLength: number; checks: Check[] | null; error?: string }): {
  verdict: Verdict;
  reason: string;
} {
  if (a.tx) {
    if (a.status === 200 && a.bodyLength > 0) {
      const failed = (a.checks ?? []).filter((c) => c.result === "fail");
      return failed.length
        ? { verdict: "not_as_described", reason: failed.map((c) => `${c.name}: ${c.detail}`).join(" / ") }
        : { verdict: "as_described", reason: "all checks passed or not applicable" };
    }
    return a.status >= 400 && a.status < 500 && a.status !== 402
      ? { verdict: "paid_then_rejected", reason: `transfer, then HTTP ${a.status}` }
      : { verdict: "paid_not_delivered", reason: a.status ? `transfer, then HTTP ${a.status}` : `transfer, then ${a.error ?? "no response"}` };
  }
  return { verdict: "not_settled", reason: a.status ? `no transfer; HTTP ${a.status}` : `no transfer; ${a.error ?? "no response"}` };
}

const jstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

// ── storage ───────────────────────────────────────────────────────────────────

const KEY = "spbuy_runs";
const localFile = () => path.join(process.cwd(), "data", "spbuy", "runs.jsonl");

export async function saveSpBuyRun(run: SpBuyRun): Promise<void> {
  if (upstashConfigured()) {
    try {
      await upstashCommand(["LPUSH", KEY, JSON.stringify(run)]);
      await upstashCommand(["LTRIM", KEY, 0, 59]);
    } catch (err) {
      console.warn(`[SP-BUY] save failed: ${String(err)}`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(localFile()), { recursive: true });
    fs.appendFileSync(localFile(), JSON.stringify(run) + "\n");
  } catch {
    /* best effort */
  }
}

export async function loadSpBuyRuns(limit = 14): Promise<SpBuyRun[]> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string[]>(["LRANGE", KEY, 0, limit - 1]);
      if (Array.isArray(raw)) return raw.map((x) => JSON.parse(x) as SpBuyRun);
    } catch (err) {
      console.warn(`[SP-BUY] load failed: ${String(err)}`);
    }
  }
  try {
    return fs.readFileSync(localFile(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SpBuyRun).reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

export interface SpBuyOptions {
  /** Select and send unpaid requests only; nothing is paid or saved. */
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  client?: ProbeClient | null;
  sources?: { items: CuratedItem[]; generatedAt: string | null; catalog: Map<string, CatalogEntry | null> };
  /** Already spent today (JST); read from the store otherwise. */
  spentToday?: number;
  write?: boolean;
  now?: Date;
  /** Looks for a payment on chain when no settlement header came back (settle-search.ts). */
  findSettlement?: typeof findSettlementOnChain;
}

export async function runSpBuy(opts: SpBuyOptions = {}): Promise<SpBuyRun> {
  const now = opts.now ?? new Date();
  const date = jstDate(now);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const write = opts.write !== false && !opts.dryRun;
  const cap = DAILY_CAP_USD();
  const src = opts.sources ?? (await loadSources(fetchImpl));
  const { targets, refused } = selectTargets(src.items, src.catalog, { today: now });
  const run: SpBuyRun = {
    at: now.toISOString(),
    date,
    dryRun: !!opts.dryRun,
    source: { curatedGeneratedAt: src.generatedAt, items: src.items.length },
    dailyCapUsd: cap,
    spentUsd: 0,
    targets: targets.length,
    records: [],
    refused,
    notCalled: [],
  };
  console.log(`[SP-BUY] ${date}: ${targets.length} targets from ${src.items.length} Seller Probe items (${refused.length} refused), budget $${cap}`);

  let spent = opts.spentToday ?? (write ? await readWeekSpend("spbuy", date) : 0);
  let preferNet: string | undefined;
  const client =
    opts.client !== undefined
      ? opts.client
      : opts.dryRun
        ? null
        : buildProbeClient(
            { run: 0, week: 0 },
            { allow: (price) => price <= PER_CALL_CAP_USD && spent + price <= cap + 1e-9, prefer: () => preferNet }
          );
  if (!client && !opts.dryRun) {
    console.warn("[SP-BUY] no paying client (Circle Base wallet not configured) — nothing bought");
  }

  for (const t of targets) {
    const cdId = `spbuy:${t.id}`;
    const cd = await loadCooldown(cdId);
    const plan = decideCall(cd, date);
    if (!plan.call) {
      run.notCalled.push({ id: t.id, host: t.host, url: t.url, reason: `cooldown: ${cd.consecutiveFallback}日続けて中身の確認に外れた${cd.lastReason ? ` — ${cd.lastReason}` : ""}` });
      continue;
    }
    if (spent + t.priceUsd > cap + 1e-9) {
      run.notCalled.push({ id: t.id, host: t.host, url: t.url, reason: `1日の予算 $${cap} に届くため今日は買わない` });
      continue;
    }
    const req = rebuildRequest(t);
    const started = Date.now();
    const base: Omit<SpBuyRecord, "verdict" | "verdict_reason" | "disagrees"> = {
      at: new Date().toISOString(),
      path: "seller-probe-daily",
      curated_id: t.id,
      operator: t.operator,
      host: t.host,
      url: t.url,
      category: t.category,
      price_usd: t.priceUsd,
      selection: t.reason,
      request: req,
      http_status: null,
      quoted_usd: null,
      tx: null,
      tx_source: null,
      network: null,
      amount_usd: null,
      response_sha256: null,
      response_bytes: null,
      summary: null,
      body_head: null,
      checks: null,
      error_body: null,
      latency_ms: 0,
    };
    const pf = await preflight(req, t, fetchImpl);
    if (!pf.ok) {
      run.records.push({ ...base, http_status: pf.status, verdict: pf.verdict, verdict_reason: pf.reason, disagrees: pf.verdict === "input_mismatch", latency_ms: Date.now() - started });
      continue;
    }
    base.quoted_usd = pf.quoted;
    if (opts.dryRun || !client) {
      if (opts.dryRun) spent += pf.quoted; // so the budget cut shows in a dry run too
      run.records.push({ ...base, http_status: 402, network: pf.network, verdict: "not_bought", verdict_reason: opts.dryRun ? "dry run: 402 を確認、払っていない" : "支払いクライアントなし", disagrees: false, latency_ms: Date.now() - started });
      continue;
    }

    // Pay once, on the network Seller Probe settled on when offered.
    preferNet = pf.network;
    let status = 0;
    let body = Buffer.alloc(0);
    let ct: string | null = null;
    let error: string | undefined;
    try {
      const res = await client.fetch(req.url, init(req));
      status = res.status;
      ct = res.headers.get("content-type");
      body = Buffer.from(await res.arrayBuffer());
      if (status !== 200) {
        let x402Error = "";
        const pr = res.headers.get("PAYMENT-REQUIRED");
        if (pr) {
          try {
            x402Error = String(JSON.parse(Buffer.from(pr, "base64").toString("utf8")).error ?? "");
          } catch {
            /* unreadable */
          }
        }
        const text = body.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 300);
        base.error_body = [x402Error && `402 error: ${x402Error}`, text].filter(Boolean).join(" | ") || null;
      }
      const h = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      if (h) {
        try {
          const s = decodePaymentResponseHeader(h);
          base.tx = s.transaction ?? null;
          base.tx_source = base.tx ? "header" : null;
          base.network = s.network ? String(s.network) : pf.network;
          const amt = (s as { amount?: string }).amount;
          base.amount_usd = amt !== undefined ? Number(BigInt(amt)) / 1e6 : pf.quoted;
        } catch {
          base.network = pf.network;
          base.amount_usd = pf.quoted;
        }
      }
    } catch (err) {
      error = String(err instanceof Error ? err.message : err).slice(0, 200);
    }
    // No settlement header: look for what we signed on chain, as Seller Probe does.
    if (!base.tx) {
      const sent = sentPaymentFromHeader(client.lastPaymentHeader?.() ?? null, client.solanaAddress);
      const found = sent ? await (opts.findSettlement ?? findSettlementOnChain)(sent, { fetchImpl }) : null;
      if (found) {
        base.tx = found.tx;
        base.tx_source = found.source;
        base.network = pf.network;
        base.amount_usd = pf.quoted;
      }
    }
    base.http_status = status || null;
    base.latency_ms = Date.now() - started;
    if (base.tx) {
      spent += base.amount_usd ?? pf.quoted;
      run.spentUsd += base.amount_usd ?? pf.quoted;
      if (write) await recordWeekSpend("spbuy", base.amount_usd ?? pf.quoted, { target: t.host, path: new URL(t.url).pathname }, date);
    }
    if (status === 200 && body.length) {
      base.checks = contentChecks({
        body,
        contentType: ct,
        description: t.description,
        output: pf.output,
        values: req.values.map((v) => ({ name: v.name, value: v.value })),
        now: new Date(),
      });
      base.response_sha256 = createHash("sha256").update(body).digest("hex");
      base.response_bytes = body.length;
      base.summary = body.toString("utf8").slice(0, 300);
      if (base.checks.some((c) => c.result === "fail")) base.body_head = body.toString("utf8").slice(0, 500);
    }
    const v = verdictOf({ status, tx: base.tx, bodyLength: body.length, checks: base.checks, error });
    if (base.error_body) v.reason += ` — ${base.error_body.slice(0, 160)}`;
    if (base.tx_source === "onchain_search") v.reason += " (settlement header missing; transfer found on chain)";
    const rec: SpBuyRecord = { ...base, verdict: v.verdict, verdict_reason: v.reason, disagrees: v.verdict !== "as_described" };
    run.records.push(rec);
    console.log(`[SP-BUY] ${t.host} ${new URL(t.url).pathname} → ${v.verdict}${rec.tx ? ` tx ${rec.tx}` : ""} ${rec.amount_usd ?? ""}`);

    // Fold into the cooldown: content counts as live; a paid body without it as a fallback day.
    if (write) {
      const outcome = v.verdict === "as_described" ? "live" : v.verdict === "not_as_described" ? "fallback" : "error";
      const ns = nextState(cd, date, outcome, plan.probe);
      if (outcome === "fallback") ns.lastReason = v.reason.slice(0, 160);
      await saveCooldown(ns);
    }
  }

  if (write) await saveSpBuyRun(run);
  const ok = run.records.filter((r) => r.verdict === "as_described").length;
  const paid = run.records.filter((r) => r.tx).length;
  console.log(`[SP-BUY] done — ${paid} paid, ${ok} as described, $${run.spentUsd.toFixed(4)} (cap $${cap})`);
  return run;
}
