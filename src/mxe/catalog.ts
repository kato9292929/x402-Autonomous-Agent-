/**
 * Function 5's public catalog: the external endpoints the probe already pays,
 * coded as (category, format, price) — what the sealed query is matched
 * against.
 *
 * Prices are not invented here. Each comes from the seller's published price
 * (`listedPerCallUsd` in probe/targets.ts) or, when nothing is published, the
 * latest quote the probe actually saw in a 402; an endpoint with neither is
 * left out. Category and format are this file's classification.
 *
 * Larger sizes are padded with entries that match no query (category 0), so
 * the same real entries are searched at N = 8, 16, 32, 64 and only the size
 * changes — which is what the cost curve needs.
 */
import { PROBE_TARGETS } from "../probe/targets";
import type { ProbeRunSummary } from "../store/probe-store";
import type { CatalogEntry, CatalogSize, SearchQuery } from "./functions";

export const CATEGORY = { padding: 0, chain: 1, filings: 2, token: 3, news: 4, search: 5 } as const;
export const FORMAT = { any: 0, json: 1, text: 2 } as const;

/** Classification of each probe path (path without its query string). */
const CLASSIFIED: Record<string, { category: number; format: number }> = {
  "onesource:/api/chain/block-number": { category: CATEGORY.chain, format: FORMAT.json },
  "2s:/api/finance/sec-filings": { category: CATEGORY.filings, format: FORMAT.json },
  "otto:/token-details": { category: CATEGORY.token, format: FORMAT.json },
  "otto:/yield-alpha": { category: CATEGORY.token, format: FORMAT.json },
  "otto:/crypto-news": { category: CATEGORY.news, format: FORMAT.text },
  "exa:/search": { category: CATEGORY.search, format: FORMAT.json },
  "exa:/contents": { category: CATEGORY.search, format: FORMAT.text },
};

export interface NamedEntry extends CatalogEntry {
  id: string;
  /** Where the price came from. */
  priceSource?: "listed" | "observed";
}

const pathKey = (target: string, path: string) => `${target}:${path.split("?")[0]}`;

/** Newest quote the probe saw for target+path, in USDC. */
function observedQuote(runs: ProbeRunSummary[], target: string, path: string): number | undefined {
  for (const run of runs) {
    for (const r of run.records) {
      if (r.target === target && pathKey(r.target, r.path) === pathKey(target, path) && r.quotedUsdc !== undefined) {
        return r.quotedUsdc;
      }
    }
  }
  return undefined;
}

/** Real entries, in a fixed order (the mask bit is the index). Suspended sellers included: the catalog is what is known, not what is paid this week. */
export function knownEndpoints(probeRuns: ProbeRunSummary[]): NamedEntry[] {
  const out: NamedEntry[] = [];
  for (const t of PROBE_TARGETS) {
    for (const p of t.probes) {
      const cls = CLASSIFIED[pathKey(t.id, p.path)];
      if (!cls) continue;
      const listed = t.listedPerCallUsd;
      const usd = listed ?? observedQuote(probeRuns, t.id, p.path);
      if (usd === undefined) continue;
      out.push({
        id: pathKey(t.id, p.path),
        ...cls,
        priceMicro: Math.round(usd * 1e6),
        priceSource: listed !== undefined ? "listed" : "observed",
      });
    }
  }
  return out;
}

export function catalogOf(size: CatalogSize, known: NamedEntry[]): NamedEntry[] {
  const out = known.slice(0, size);
  for (let i = out.length; i < size; i++) {
    out.push({ id: `padding:${i}`, category: CATEGORY.padding, format: FORMAT.json, priceMicro: 0 });
  }
  return out;
}

/** A stable version number for a catalog's contents. */
export function catalogVersion(entries: CatalogEntry[]): number {
  let h = 2166136261;
  for (const e of entries) {
    for (const v of [e.category, e.format, e.priceMicro]) {
      h ^= v & 0xffffffff;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

/** What the AA looks for: a small daily rotation over the categories it buys. */
export const DAILY_QUERIES: SearchQuery[] = [
  { category: CATEGORY.token, format: FORMAT.any, maxPriceMicro: 5_000 },
  { category: CATEGORY.search, format: FORMAT.json, maxPriceMicro: 20_000 },
  { category: CATEGORY.filings, format: FORMAT.any, maxPriceMicro: 10_000 },
  { category: CATEGORY.chain, format: FORMAT.json, maxPriceMicro: 10_000 },
];

export function queryFor(d: Date = new Date()): SearchQuery {
  const day = Math.floor(d.getTime() / 86_400_000);
  return DAILY_QUERIES[day % DAILY_QUERIES.length];
}
