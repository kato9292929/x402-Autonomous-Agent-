/**
 * The five external x402 sellers the weekly probe calls.
 *
 * Purpose: measure quality and real cost against third parties, outside our own
 * economy. Call counts are not the point — §9 of the worksheet is explicit that
 * this is not a ranking exercise.
 *
 * Paths: only routes the worksheet actually names are listed here. For the
 * sellers whose routes are unconfirmed (2s / GoCreative / BlockRun), `probes` is
 * empty on purpose — run 0 reads `/.well-known/x402` and `/openapi.json` and
 * reports what those hosts advertise, and the routes get added from that report
 * rather than guessed. A guessed path returns 404 and looks like a dead seller.
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
  /** Routes the sweep pays for. Empty until run 0 confirms what exists. */
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
    listedChains: ["ethereum", "sepolia", "robinhood-chain"],
    weeklyCallBudget: 20,
    metadata: ["/.well-known/x402", "/openapi.json", "/api/pricing", "/api/networks"],
    probes: [],
    question: "Robinhood Chain のオンチェーン検証が osd に効くか",
  },
  {
    id: "2s",
    name: "2s",
    host: "https://2s.io",
    listedPerCallUsd: 0.0025,
    listedChains: ["base", "solana", "ethereum"],
    weeklyCallBudget: 10,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [],
    question: "SEC EDGAR・連邦データの粒度。Watchers(署名付きコールバック)の転用可否",
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
    // 掲載は中央値 $0.05。単価も機能も未確認なので run 0 の discovery で埋める。
    listedPerCallUsd: 0.05,
    listedChains: [],
    weeklyCallBudget: 5,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [],
    question: "規制・コンプラデータの中身と対応地域。単価が予算内に収まるか",
  },
  {
    id: "blockrun",
    name: "BlockRun",
    host: "https://blockrun.ai",
    // 原価+5%。固定の per-call が無いので掲載価格は置かない(推測しない)。
    listedChains: ["base", "solana"],
    weeklyCallBudget: 5,
    metadata: ["/.well-known/x402", "/openapi.json"],
    probes: [],
    question: "モデル/RPC/検索の調達価格。原価+5% と単一障害点(ロックイン)の評価",
  },
];

/** Total paid calls a full sweep would make if every route were known. */
export function plannedCallCount(targets = PROBE_TARGETS): number {
  return targets.reduce((n, t) => n + Math.min(t.weeklyCallBudget, t.probes.length), 0);
}
