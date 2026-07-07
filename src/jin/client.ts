/**
 * Japan Inflation Nowcast (JIN) の薄い x402 クライアント。
 *
 * 段階2は新規決済実装ではなく、AA が既に osd で動かしている x402 決済フロー
 * (共有クライアント fetchWithPayment / @x402 の 402 自動応答・署名・facilitator) を
 * JIN に向けるだけ。支払いクライアント・署名・facilitator は一切作り替えない。
 *
 * 叩く先(base URL)・resource はハードコードせずパラメータ化する。amount / asset / payTo /
 * network は discovery および 402 が返すライブの値をそのまま使い、コードに直書きしない
 * (特に Solana USDC mint は転記事故を避けるため必ずライブ値を正とする)。
 */
import { decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { fetchWithPayment } from "../x402";

/** JIN の本番配信ベース URL。JIN_API_BASE で上書き可能。 */
export function jinBase(): string {
  return process.env.JIN_API_BASE ?? "https://jin-orcin-pi.vercel.app";
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** discovery / 402 から取り出す 1 leg 分の要点(フィールド名は v1/v2 両対応)。 */
export interface JinLeg {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string; // v2
  maxAmountRequired?: string; // v1
  payTo?: string;
  resource?: string;
}

/** leg の amount を v2(amount)/v1(maxAmountRequired) 両対応で読む。 */
export function legAmount(leg: JinLeg): string | undefined {
  return leg.amount ?? leg.maxAmountRequired;
}

// ── 疎通(§0) ─────────────────────────────────────────────────────────────────

/** 無料 GET /api/jin/latest。決済不要。疎通確認に使う。 */
export async function fetchLatest(): Promise<{ status: number; ok: boolean }> {
  return withTimeout(async (signal) => {
    const res = await fetch(`${jinBase()}/api/jin/latest`, { signal });
    await res.text().catch(() => undefined);
    return { status: res.status, ok: res.ok };
  });
}

/** GET /.well-known/x402.json。discovery ドキュメント(JSON)を返す。 */
export async function fetchDiscovery(): Promise<{ status: number; doc: unknown }> {
  return withTimeout(async (signal) => {
    const res = await fetch(`${jinBase()}/.well-known/x402.json`, { signal });
    const text = await res.text().catch(() => "");
    let doc: unknown = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    return { status: res.status, doc };
  });
}

/**
 * discovery ドキュメント中から payTo を持つ leg を再帰的に収集する。
 * discovery のトップ構造は実装差があるため(accepts 配列 / resource キーの map など)、
 * 形に依存せず payTo を持つオブジェクトを拾う。resource/network/amount は在れば拾う。
 */
export function collectLegs(doc: unknown): JinLeg[] {
  const out: JinLeg[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, resourceHint?: string): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v, resourceHint);
      return;
    }
    const obj = node as Record<string, unknown>;
    // このオブジェクト自身が resource を持つなら子への hint にする
    const localResource =
      typeof obj.resource === "string" ? (obj.resource as string) : resourceHint;
    if (typeof obj.payTo === "string") {
      out.push({
        scheme: typeof obj.scheme === "string" ? obj.scheme : undefined,
        network: typeof obj.network === "string" ? obj.network : undefined,
        asset: typeof obj.asset === "string" ? obj.asset : undefined,
        amount: typeof obj.amount === "string" ? obj.amount : undefined,
        maxAmountRequired:
          typeof obj.maxAmountRequired === "string" ? obj.maxAmountRequired : undefined,
        payTo: obj.payTo as string,
        resource: localResource,
      });
    }
    // map 形式(キーが URL)の場合、キーを resource hint として子へ渡す
    for (const [k, v] of Object.entries(obj)) {
      const hint = /https?:\/\/|\/api\//.test(k) ? k : localResource;
      walk(v, hint);
    }
  };
  walk(doc);
  return out;
}

/** discovery legs から series 用(resource に "series" を含む)を優先的に選ぶ。 */
export function pickSeriesLeg(legs: JinLeg[]): JinLeg | undefined {
  const seriesLegs = legs.filter((l) => (l.resource ?? "").toLowerCase().includes("series"));
  const pool = seriesLegs.length > 0 ? seriesLegs : legs;
  return pool.find((l) => (l.network ?? "").toLowerCase().includes("solana")) ?? pool[0];
}

// ── 402 チャレンジ取得(無支払い) ─────────────────────────────────────────────

export interface Probe402Result {
  status: number;
  /** 402 の accept legs(ライブの正値)。payTo/amount/asset/network はここを使う。 */
  legs: JinLeg[];
  raw?: unknown;
}

/**
 * pathname を無支払いで GET し、402 の PAYMENT-REQUIRED を decode して accept legs を返す。
 * v2 ヘッダが無ければ本文 JSON(accepts) にフォールバックする。
 */
export async function probe402(pathname: string): Promise<Probe402Result> {
  return withTimeout(async (signal) => {
    const res = await fetch(`${jinBase()}${pathname}`, { signal });
    const bodyText = await res.text().catch(() => "");

    let legs: JinLeg[] = [];
    const header = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("X-PAYMENT-REQUIRED");
    if (header) {
      try {
        const decoded = decodePaymentRequiredHeader(header) as { accepts?: JinLeg[] };
        legs = decoded.accepts ?? [];
      } catch {
        legs = [];
      }
    }
    if (legs.length === 0 && bodyText) {
      try {
        const j = JSON.parse(bodyText) as { accepts?: JinLeg[] };
        if (Array.isArray(j.accepts)) legs = j.accepts;
      } catch {
        // 本文も JSON でなければ legs は空のまま
      }
    }
    return { status: res.status, legs };
  });
}

// ── 支払い(既存 osd と同じ経路) ───────────────────────────────────────────────

export interface JinPaidResult {
  status: number;
  /** 決済トランザクション署名(Solana の signature)。 */
  signature: string | null;
  network: string;
  body: unknown;
}

/**
 * pathname を fetchWithPayment で叩く。402 の accept leg どおりに共有 x402 クライアントが
 * 支払う(amount/asset/network は 402 の値。ここで直書きしない)。200 なら本文と署名を返す。
 */
export async function payAndFetch(pathname: string): Promise<JinPaidResult> {
  const res = await fetchWithPayment(`${jinBase()}${pathname}`, { method: "GET" });
  const bodyText = await res.text().catch(() => "");
  let body: unknown = bodyText;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // JSON でなければ生テキストのまま
  }

  let signature: string | null = null;
  let network = "solana";
  const header =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (header) {
    try {
      const decoded = decodePaymentResponseHeader(header) as {
        transaction?: string;
        network?: string;
      };
      signature = decoded.transaction ?? null;
      if (decoded.network) network = decoded.network;
    } catch {
      // header はあるが decode 不能 — signature は null のまま
    }
  }
  return { status: res.status, signature, network, body };
}
