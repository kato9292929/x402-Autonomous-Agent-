/**
 * Does a paid response carry anything?
 *
 * x402 settles before the body arrives, so a 200 can be paid for and still be
 * empty: a list with no rows, a body that only repeats what we sent, or a
 * "daily" feed whose text has not changed for days. The stub detector catches
 * bodies that say they are fallback; this catches the ones that do not say so.
 *
 * Findings from the 11/4–11/12 runs that these rules encode:
 *   - Smart Money Screener  tokens [] / total_scanned 0 every day; its own
 *     warnings say Nansen has no smart-money flows for base or solana.
 *   - Divergence Analyzer   results [] every day.
 *   - Whale Alert           transfers carry tx_hash "0xabc123", not a tx.
 *   - APAC Daily            the same summary_ja every day since 11/4.
 *   - Portfolio Intelligence the peek is only our own input echoed back.
 *
 * A failed check is treated like a fallback day by Mode B's cooldown: after
 * FALLBACK_DAYS such days the endpoint is not bought daily, only probed every
 * PROBE_INTERVAL_DAYS, and the first body with content resumes it.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { upstashCommand, upstashConfigured } from "./store/upstash-rest";

export interface ContentCheck {
  ok: boolean;
  /** What was missing, in words for the run card. */
  reason?: string;
  /** Judged afterwards from the kept body (runs before this check existed). */
  inferred?: boolean;
}

type Json = Record<string, unknown>;

/** Keys that describe the request or the response itself, not its content. */
const META_KEY = /^(scannedAt|fetched_at|fetchedAt|analyzedAt|generatedAt|generated_at|updatedAt|updated_at|timestamp|date|as_of|asOf|source|chain|region|warnings?|errors?|version|requestId|request_id|area|propertyType|walletAddress|riskTolerance)$/;

/** Number of leaf values that carry content: not meta, not echoed input, not empty. */
export function substantiveLeaves(v: unknown, echo: Set<string> = new Set(), key = ""): number {
  if (key && META_KEY.test(key)) return 0;
  if (v === null || v === undefined || v === "" || v === false) return 0;
  if (typeof v === "number") return v === 0 ? 0 : 1;
  if (typeof v === "string") return echo.has(v) ? 0 : 1;
  if (typeof v === "boolean") return 1;
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + substantiveLeaves(x, echo), 0);
  if (typeof v === "object") {
    let n = 0;
    for (const [k, x] of Object.entries(v as Json)) n += substantiveLeaves(x, echo, k);
    return n;
  }
  return 0;
}

const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const REAL_EVM_TX = /^0x[0-9a-fA-F]{64}$/;

/** Endpoint-specific rules, keyed by endpoint id. Return a reason when empty. */
const RULES: Record<string, (d: Json) => string | undefined> = {
  "smart-money-screener": (d) => {
    const tokens = arr(d.tokens);
    if (tokens && tokens.length > 0) return undefined;
    const w = arr(d.warnings)?.[0];
    return `tokens 0件(total_scanned ${String(d.total_scanned ?? "—")})${w ? `: ${String(w).slice(0, 90)}` : ""}`;
  },
  "divergence-analyzer": (d) => (arr(d.results)?.length ? undefined : "results 0件"),
  "onchain-feed-whale": (d) => {
    const ts = arr(d.transfers) ?? [];
    if (!ts.length) return "transfers 0件";
    const fake = ts
      .map((t) => (t as Json)?.tx_hash ?? (t as Json)?.txHash)
      .filter((h) => typeof h === "string" && !REAL_EVM_TX.test(h as string));
    return fake.length ? `transfers の tx_hash が実在しない形(${String(fake[0])})` : undefined;
  },
};

/**
 * Feeds sold as daily: a body identical to the previous day's (timestamps
 * aside) is not a new day's data.
 */
export const MUST_CHANGE_DAILY = new Set(["onchain-feed-apac", "onchain-feed-whale"]);

/** Pure part of the check: the body alone. `sent` is what we sent (POST body / query). */
export function checkBody(endpointId: string, data: unknown, sent: Json = {}): ContentCheck {
  if (data === null || typeof data !== "object" || Object.keys(data as Json).length === 0) {
    return { ok: false, reason: "本文が空" };
  }
  const rule = RULES[endpointId];
  const r = rule?.(data as Json);
  if (r) return { ok: false, reason: r };
  const echo = new Set(Object.values(sent).filter((v): v is string => typeof v === "string" && v.length > 0));
  if (substantiveLeaves(data, echo) === 0) {
    return { ok: false, reason: echo.size ? "送った入力の繰り返しだけで中身が無い" : "値の入った項目が無い" };
  }
  return { ok: true };
}

/** Body with timestamp-like fields removed, hashed, for the daily-change rule. */
export function contentHash(data: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Json = {};
      for (const k of Object.keys(v as Json).sort()) {
        if (/(At|_at|^date|timestamp|as_of|asOf)$/i.test(k) || /^date$/.test(k)) continue;
        out[k] = strip((v as Json)[k]);
      }
      return out;
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(strip(data))).digest("hex").slice(0, 16);
}

interface HashState {
  hash: string;
  /** Day (YYYY-MM-DD) the hash was first seen. */
  since: string;
}

const hashKey = (id: string) => `content_hash:${id}`;
const localFile = () => path.join(process.cwd(), "data", "cooldown", "content-hash.json");

async function loadHash(id: string): Promise<HashState | undefined> {
  if (upstashConfigured()) {
    try {
      const raw = await upstashCommand<string | null>(["GET", hashKey(id)]);
      return raw ? (JSON.parse(raw) as HashState) : undefined;
    } catch {
      /* local below */
    }
  }
  try {
    return (JSON.parse(fs.readFileSync(localFile(), "utf-8")) as Record<string, HashState>)[id];
  } catch {
    return undefined;
  }
}

async function saveHash(id: string, s: HashState): Promise<void> {
  if (upstashConfigured()) {
    try {
      await upstashCommand(["SET", hashKey(id), JSON.stringify(s)]);
    } catch (err) {
      console.warn(`[CONTENT] hash save failed for ${id}: ${String(err)}`);
    }
  }
  try {
    let all: Record<string, HashState> = {};
    try {
      all = JSON.parse(fs.readFileSync(localFile(), "utf-8"));
    } catch {
      /* new file */
    }
    all[id] = s;
    fs.mkdirSync(path.dirname(localFile()), { recursive: true });
    fs.writeFileSync(localFile(), JSON.stringify(all), "utf-8");
  } catch {
    /* best effort */
  }
}

/** Pure: given the stored hash, is today's body unchanged? Returns the next state too. */
export function dailyChange(prev: HashState | undefined, hash: string, today: string): { unchanged: boolean; next: HashState } {
  if (prev && prev.hash === hash && prev.since < today) return { unchanged: true, next: prev };
  if (prev && prev.hash === hash) return { unchanged: false, next: prev };
  return { unchanged: false, next: { hash, since: today } };
}

/** Full check: the body rules, then (for daily feeds) whether it changed since an earlier day. */
export async function checkContent(endpointId: string, data: unknown, sent: Json = {}): Promise<ContentCheck> {
  const body = checkBody(endpointId, data, sent);
  if (!body.ok || !MUST_CHANGE_DAILY.has(endpointId)) return body;
  const today = new Date().toISOString().slice(0, 10);
  const { unchanged, next } = dailyChange(await loadHash(endpointId), contentHash(data), today);
  await saveHash(endpointId, next);
  return unchanged ? { ok: false, reason: `${next.since} から本文が同じ(日付だけ更新)` } : body;
}

/**
 * For runs recorded before this check existed: judge the body that was kept
 * (`fullData`, or the peek when it is a complete JSON document). Leaves the
 * result alone when neither is available. `inferred` marks it as read back.
 */
interface Judgeable {
  endpoint: string;
  status: string;
  content?: ContentCheck;
  fullData?: unknown;
  responsePeek?: string;
}

export function backfillContent<T extends Judgeable>(r: T, idOf: (url: string) => string | undefined): T & { content?: ContentCheck } {
  if (r.content || r.status !== "success") return r;
  let body: unknown = r.fullData;
  if (body === undefined && r.responsePeek) {
    try {
      body = JSON.parse(r.responsePeek);
    } catch {
      return r; // cut off at 120 chars: not enough to judge
    }
  }
  if (body === undefined) return r;
  const id = idOf(r.endpoint) ?? "";
  const sent: Json = {};
  try {
    for (const [k, v] of new URL(r.endpoint).searchParams) sent[k] = v;
  } catch {
    /* not a URL */
  }
  return { ...r, content: { ...checkBody(id, body, sent), inferred: true } };
}
