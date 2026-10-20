/**
 * The five external x402 sellers the weekly probe calls.
 *
 * Purpose: measure quality and real cost against third parties, outside our own
 * economy. Call counts are not the point — §9 of the worksheet is explicit that
 * this is not a ranking exercise.
 *
 * Each configured paid route was advertised by the seller and returned 402 in
 * an unpaid request on 2026-09-18. Required parameters are taken from OpenAPI.
 * The paying client still checks the live 402 before signing.
 *
 * Cluster Protocol is deliberately absent: it is deployment infrastructure, not
 * a data API.
 */

export interface ProbePath {
  path: string;
  method: "GET" | "POST";
  /** Request body for POST routes. */
  body?: Record<string, unknown>;
  note?: string;
}

export interface ProbeTarget {
  id: string;
  name: string;
  /** Origin, no trailing slash. */
  host: string;
  /** Per-call price as published. Undefined = not published anywhere we can read. */
  listedPerCallUsd?: number;
  /** Chains the seller advertises. Informational — the real list comes from the 402. */
  listedChains: string[];
  /** Max paid calls per weekly sweep (§2). */
  weeklyCallBudget: number;
  /** Free, unpaid routes read during run 0 to discover what the seller offers. */
  metadata: string[];
  /** Seller-advertised, read-only routes the sweep may pay for. */
  probes: ProbePath[];
  /** What we are trying to learn from this seller. */
  question: string;
  /**
   * Set when the seller is not to be paid for now.
   *
   * The paid sweep skips it; run 0 still reads it, because run 0 costs nothing
   * and an unreachable seller that comes back should be noticed rather than
   * waited for. Removing a target outright loses that, and loses the reason.
   */
  suspended?: { since: string; reason: string };
}

/**
 * Routes that move money or take a position. Never called — this probe reads.
 *
 * Matched as a path substring against every request the probe makes, for every
 * seller, not just the one whose docs we happen to have read.
 */
export const EXECUTION_PATH_PATTERNS = [
  "/swap",
  "/trade",
  "/execute",
  "/order",
  "/transfer",
  "/withdraw",
  "/bridge",
  "/deposit",
  "/mint",
  "/sell",
  "/buy",
];

/** True when a path looks like it would execute rather than report. */
export function isExecutionPath(path: string): boolean {
  const lower = path.toLowerCase();
  return EXECUTION_PATH_PATTERNS.some((p) => lower.includes(p));
}

export const PROBE_TARGETS: ProbeTarget[] = [
  {
    id: "onesource",
    name: "OneSource",
    host: "https://api.onesource.io",
    listedPerCallUsd: 0.004,
    listedChains: ["base"],
    weeklyCallBudget: 20,
    metadata: ["/.well-known/x402", "/openapi.json", "/api/pricing", "/api/networks"],
    probes: [{ path: "/api/chain/block-number", method: "GET" }],
    question: "Ethereum の最新ブロック情報の品質・応答時間を測る",
  },
  {
    id: "2s",
    name: "2s",
    host: "https://2s.io",
    listedPerCallUsd: 0.0025,
    listedChains: ["base", "solana", "ethereum"],
    weeklyCallBudget: 10,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [{ path: "/api/finance/sec-filings?ticker=NVDA&limit=5", method: "GET" }],
    question: "NVDA の SEC filings データの粒度と鮮度を測る",
  },
  {
    id: "otto",
    name: "Otto AI",
    host: "https://x402.ottoai.services",
    listedPerCallUsd: 0.001,
    listedChains: ["base", "polygon", "solana"],
    weeklyCallBudget: 10,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [
      // `symbol` は OpenAPI 上 required。無しで叩くと 402 は返るが、支払いを
      // 提示した2回目で 400 になる(2026-10-20 の sweep で実際にそうなった)。
      // 402 はパラメータ検証より前に出るので、run 0 では捕まえられない欠陥だった。
      { path: "/token-details?symbol=SOL", method: "GET" },
      { path: "/yield-alpha", method: "GET" },
      { path: "/crypto-news", method: "GET" },
    ],
    question: "DeFi/トークン intelligence が JIN・osd の材料になるか（執行系は叩かない）",
  },
  {
    id: "gocreative",
    name: "GoCreative",
    host: "https://api.gocreativeai.com",
    // 掲載は中央値 $0.05。実際の請求額は決済レスポンスで測る。
    listedPerCallUsd: 0.05,
    listedChains: ["base"],
    weeklyCallBudget: 5,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [{ path: "/v1/fred/series/GDP", method: "GET" }],
    question: "FRED GDP データの内容と鮮度を測る",
    // 2026-10-20: オリジン全体が 502。ルート単体ではなく `/`・`/.well-known/x402`
    // も同じなので、売り手側が落ちている。復帰は run 0(無課金)で検知する。
    suspended: {
      since: "2026-10-20",
      reason: "オリジン全体が 502(`/`・`/.well-known/x402`・有料ルートすべて)",
    },
  },
  {
    id: "blockrun",
    name: "BlockRun",
    host: "https://blockrun.ai",
    // 原価+5%。固定の per-call が無いので掲載価格は置かない(推測しない)。
    listedChains: ["base", "solana"],
    weeklyCallBudget: 5,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [{ path: "/api/v1/search", method: "POST", body: { query: "US inflation data", sources: ["web"], max_results: 3 } }],
    question: "Web 検索の返り値と実費を測る",
    // 2026-10-20 の sweep で 500。無課金の 402 は3回とも正常に返る($0.081)ので、
    // 支払いを提示したあとに壊れている = 売り手側。こちらに直せるものが無い。
    //
    // 単価も他の先の10〜80倍で、$0.081 は週上限 $4.00 の 2% を1コールで使う。
    // 払えていない以上、毎週その枠を空振りに充てる理由が無い。
    // run 0 は無課金で読み続けるので、復帰も値下げもそこで分かる。
    suspended: {
      since: "2026-10-20",
      reason: "支払い提示後に HTTP 500(無課金の 402 は正常)。売り手側の障害",
    },
  },
  {
    id: "exa",
    name: "Exa",
    host: "https://api.exa.ai",
    // 掲載価格は読んでいないので置かない。単価は 402 から取る($0.001 / $0.007)。
    listedChains: ["base", "solana", "worldchain", "arc"],
    weeklyCallBudget: 10,
    // `/.well-known/x402` は 404(2026-10-20 実測)。入れたままだと毎回エラー行になり、
    // 有料ルートの成功率まで下がる。Exa は OpenAPI を配っているのでそちらを読む。
    metadata: ["/openapi.json"],
    probes: [
      // 安い方を先に置く。打ち切りが起きたとき、残るのが $0.001 側になる。
      { path: "/contents", method: "POST", body: { urls: ["https://en.wikipedia.org/wiki/Stablecoin"] } },
      { path: "/search", method: "POST", body: { query: "x402 payment protocol adoption", numResults: 5 } },
    ],
    question:
      "検索・本文抽出の質と実費を測る。/search は BlockRun と同じ Web 検索で単価が1桁違う($0.007 vs $0.081)ので、" +
      "同じ枠に並べる意味がある。Arc leg を持つ初めての第三者でもある",
  },
];

/** Total paid calls a full sweep would make if every route were known. */
export function plannedCallCount(targets = PROBE_TARGETS): number {
  return targets
    .filter((t) => !t.suspended)
    .reduce((n, t) => n + Math.min(t.weeklyCallBudget, t.probes.length), 0);
}
