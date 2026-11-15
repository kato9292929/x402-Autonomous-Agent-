/**
 * Which external endpoints the daily Seller Probe–driven purchase buys.
 *
 * Chosen afresh before every run, never a fixed list. The source is Seller
 * Probe's per-endpoint verdicts from its "使い方どおりの購入" (⑥, since
 * 2026-11-08), published at probe.x402jp.com/data/curated.json: one item per
 * endpoint (route), with the request it was bought with and the verdict.
 * `GET /scores/:host` is not used: it is per host and mixes the older
 * input-less purchases with ⑥, which is how 2s and Otto AI were wrongly
 * skipped on routes they serve fine (11/13).
 *
 * An endpoint is bought when all of these hold (each refusal is recorded):
 *   - Seller Probe's latest verdict on it is 説明どおり (as_described),
 *   - that verdict is at most SP_BUY_MAX_AGE_DAYS (14) days old,
 *   - it costs at most $0.01 a call (Seller Probe ⑥'s own ceiling),
 *   - it settled on Base mainnet or Solana mainnet,
 *   - the request Seller Probe used is complete (method, URL, query, body),
 *   - it is listed on x402 Endpoint: GET /api/endpoints/:id answers, or Seller
 *     Probe recorded it from one of x402 Endpoint's tables (the API serves only
 *     a 20,000-endpoint subset of the 210,514 catalog, so many listed
 *     endpoints answer 404 there),
 *   - it is not ours (x402jp.com hosts, our payTo addresses, our own sellers).
 * Then at most SP_BUY_PER_OPERATOR (2) per operator, taken round-robin across
 * categories so no one operator or category fills the day.
 */

export const CURATED_URL = () => process.env.SP_BUY_CURATED_URL ?? "https://probe.x402jp.com/data/curated.json";
export const ENDPOINT_API = () => (process.env.SP_BUY_ENDPOINT_API ?? "https://endpoint.x402jp.com").replace(/\/$/, "");

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
export const MAX_AGE_DAYS = () => num("SP_BUY_MAX_AGE_DAYS", 14);
export const PER_CALL_CAP_USD = 0.01;
export const PER_OPERATOR = () => num("SP_BUY_PER_OPERATOR", 2);

/** Networks the agent's wallets can pay (Circle Base, Circle Solana). */
export const PAYABLE_NETWORKS = new Set(["eip155:8453", "base", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana"]);

/** Our own hosts and payTo addresses: never bought on this path. */
export const OWN_HOST = /(^|\.)x402jp\.com$|^(osd-coral|jin-orcin-pi|odo-gamma)\.vercel\.app$|^(x402amd|x402yi|x402pi|x402-jrey|x402nansenpolymarket|smartmoneyscreener|x402oif|x402-hl)\.vercel\.app$/i;
export const OWN_PAYTO = new Set(
  ["4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf", "0xC67d94504696960bA0f2e7C3FeE703950734c00A"].map((a) => a.toLowerCase())
);

export interface CuratedRequest {
  method: string;
  url: string;
  query?: Record<string, unknown>;
  body?: unknown;
  values?: Array<{ in: string; name: string; value: unknown; from: string }>;
}

/** One item of curated.json, as far as this path reads it. */
export interface CuratedItem {
  id: string;
  operator: string;
  operator_key: string;
  host: string;
  url: string;
  name?: string;
  description?: string;
  category?: string;
  price_usd?: number | null;
  reasons?: { listed_in?: string[] };
  last?: {
    ts: string;
    date: string;
    category: string;
    category_label?: string;
    request?: CuratedRequest | null;
    network?: string;
    amount?: string;
    tx?: string | null;
  } | null;
}

/** What x402 Endpoint says about one endpoint, when its API has it. */
export interface CatalogEntry {
  id: string;
  category?: string;
  price?: { amount?: number };
  networks?: string[];
}

export interface Target {
  id: string;
  operator: string;
  operatorKey: string;
  host: string;
  url: string;
  description: string | null;
  category: string;
  priceUsd: number;
  network: string;
  request: CuratedRequest;
  /** Why it was chosen: Seller Probe's verdict and its date, and how x402 Endpoint lists it. */
  reason: { probeDate: string; probeVerdict: string; probeTx: string | null; listed: string };
}

export interface Refusal {
  id: string;
  host: string;
  url: string;
  reason: string;
}

const dayMs = 86_400_000;

/** Pure: the day's targets from curated.json items and x402 Endpoint lookups. */
export function selectTargets(
  items: CuratedItem[],
  catalog: Map<string, CatalogEntry | null>,
  opts: { today: Date; ownHosts?: Set<string> } = { today: new Date() }
): { targets: Target[]; refused: Refusal[] } {
  const refused: Refusal[] = [];
  const ok: Target[] = [];
  const refuse = (i: CuratedItem, reason: string) => refused.push({ id: i.id, host: i.host, url: i.url, reason });
  for (const i of items) {
    const last = i.last;
    if (!last) { refuse(i, "Seller Probe の判定なし"); continue; }
    if (last.category !== "as_described") { refuse(i, `判定が説明どおりでない: ${last.category_label ?? last.category}`); continue; }
    const age = (opts.today.getTime() - Date.parse(last.ts)) / dayMs;
    if (!(age <= MAX_AGE_DAYS())) { refuse(i, `判定が古い(${last.date}、${MAX_AGE_DAYS()}日超)`); continue; }
    const price = last.amount ? Number(last.amount) / 1e6 : Number(i.price_usd);
    if (!(price > 0 && price <= PER_CALL_CAP_USD)) { refuse(i, `価格 $${price} が上限 $${PER_CALL_CAP_USD} の外`); continue; }
    if (!last.network || !PAYABLE_NETWORKS.has(last.network)) { refuse(i, `払えないネットワーク(${last.network ?? "?"})`); continue; }
    const req = last.request;
    if (!req || !req.method || !req.url) { refuse(i, "Seller Probe の要求が記録されていない"); continue; }
    let host = "";
    try { host = new URL(req.url).hostname.toLowerCase(); } catch { refuse(i, "要求の URL が読めない"); continue; }
    if (OWN_HOST.test(host) || opts.ownHosts?.has(host)) { refuse(i, "自社のエンドポイント"); continue; }
    const entry = catalog.get(i.id);
    const tables = i.reasons?.listed_in ?? [];
    const listed = entry ? `x402 Endpoint API (${i.id})` : tables.length ? `x402 Endpoint の一覧表: ${tables.join(", ")}` : "";
    if (!listed) { refuse(i, "x402 Endpoint に載っていない"); continue; }
    ok.push({
      id: i.id,
      operator: i.operator,
      operatorKey: i.operator_key,
      host,
      url: req.url,
      description: i.description ?? null,
      category: (entry?.category ?? i.category ?? "other").toLowerCase(),
      priceUsd: price,
      network: last.network,
      request: req,
      reason: { probeDate: last.date, probeVerdict: last.category_label ?? last.category, probeTx: last.tx ?? null, listed },
    });
  }

  // At most PER_OPERATOR per operator (cheapest first), then round-robin by category.
  const perOp = new Map<string, Target[]>();
  for (const t of ok.sort((a, b) => a.priceUsd - b.priceUsd)) {
    const list = perOp.get(t.operatorKey) ?? [];
    if (list.length >= PER_OPERATOR()) { refused.push({ id: t.id, host: t.host, url: t.url, reason: `同じ事業者の上限 ${PER_OPERATOR()} 本を超える` }); continue; }
    perOp.set(t.operatorKey, [...list, t]);
  }
  const byCat = new Map<string, Target[]>();
  for (const t of [...perOp.values()].flat()) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
  // Within a category, alternate operators so two of one operator are not adjacent.
  for (const [c, list] of byCat) {
    const ops = new Map<string, Target[]>();
    for (const t of list) ops.set(t.operatorKey, [...(ops.get(t.operatorKey) ?? []), t]);
    const out: Target[] = [];
    for (let k = 0; out.length < list.length; k++) for (const l of ops.values()) if (l[k]) out.push(l[k]);
    byCat.set(c, out);
  }
  const cats = [...byCat.keys()].sort();
  const targets: Target[] = [];
  for (let k = 0; targets.length < ok.length; k++) {
    let added = false;
    for (const c of cats) {
      const t = byCat.get(c)![k];
      if (t) { targets.push(t); added = true; }
    }
    if (!added) break;
  }
  return { targets, refused };
}

/** Fetch curated.json and the x402 Endpoint entries of its as_described items. */
export async function loadSources(fetchImpl: typeof fetch = fetch): Promise<{
  items: CuratedItem[];
  generatedAt: string | null;
  catalog: Map<string, CatalogEntry | null>;
}> {
  const r = await fetchImpl(CURATED_URL(), { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`curated.json: HTTP ${r.status}`);
  const doc = (await r.json()) as { generated_at?: string; items?: CuratedItem[] };
  const items = doc.items ?? [];
  const catalog = new Map<string, CatalogEntry | null>();
  for (const i of items.filter((x) => x.last?.category === "as_described")) {
    try {
      const e = await fetchImpl(`${ENDPOINT_API()}/api/endpoints/${encodeURIComponent(i.id)}`, { signal: AbortSignal.timeout(10_000) });
      catalog.set(i.id, e.ok ? ((await e.json()) as CatalogEntry) : null);
    } catch {
      catalog.set(i.id, null);
    }
  }
  return { items, generatedAt: doc.generated_at ?? null, catalog };
}
