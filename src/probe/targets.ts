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
      { path: "/token-details", method: "GET" },
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
  },
];

/** Total paid calls a full sweep would make if every route were known. */
export function plannedCallCount(targets = PROBE_TARGETS): number {
  return targets.reduce((n, t) => n + Math.min(t.weeklyCallBudget, t.probes.length), 0);
}
