const getEnvOrDefault = (envName: string, defaultUrl: string): string =>
  process.env[envName] || defaultUrl;

export interface EndpointConfig {
  id: string;
  name: string;
  url: string;
  method: "GET" | "POST";
  cost: number;
  chain: "base" | "solana" | "polygon" | "bnb";
  mode: "B" | "C" | "D";
  captureFullData?: boolean;
}

export const ENDPOINTS_MODE_B: EndpointConfig[] = [
  {
    id: "apac-macro-dashboard",
    name: "APAC Macro Dashboard",
    url: getEnvOrDefault("APAC_MACRO_URL", "https://x402amd.vercel.app/api/macro/dashboard"),
    method: "GET",
    cost: 0.30,
    chain: "base",
    mode: "B",
  },
  {
    id: "yield-intelligence",
    name: "Yield Intelligence",
    url: getEnvOrDefault("YIELD_INTELLIGENCE_URL", "https://x402yi.vercel.app/api/yield/scan"),
    method: "GET",
    cost: 0.20,
    chain: "base",
    mode: "B",
    // 実レスポンスから apyResolved / liveSources / smartMoney を観測ログに出すため保持
    captureFullData: true,
  },
  {
    id: "portfolio-intelligence",
    name: "Portfolio Intelligence",
    url: getEnvOrDefault("PORTFOLIO_INTELLIGENCE_URL", "https://x402pi.vercel.app/api/portfolio/analyze"),
    method: "POST",
    cost: 0.50,
    chain: "base",
    mode: "B",
  },
  {
    id: "japan-real-estate",
    name: "Japan Real Estate Yield",
    url: getEnvOrDefault("JAPAN_REAL_ESTATE_URL", "https://x402-jrey.vercel.app/api/realestate/yield?area=tokyo"),
    method: "GET",
    cost: 0.30,
    chain: "base",
    mode: "B",
  },
  {
    id: "divergence-analyzer",
    name: "Divergence Analyzer",
    url: getEnvOrDefault("DIVERGENCE_ANALYZER_URL", "https://x402nansenpolymarket.vercel.app/api/divergence/scan"),
    method: "GET",
    cost: 0.15,
    chain: "base",
    mode: "B",
    // Mode A reuses this full response as its decision input (no re-fetch, no double charge)
    captureFullData: true,
  },
  {
    id: "hyperliquid-intelligence",
    name: "Hyperliquid Intelligence",
    url: getEnvOrDefault("HYPERLIQUID_INTELLIGENCE_URL", "https://x402-hl.vercel.app/api/hyperliquid/scan"),
    method: "GET",
    cost: 0.20,
    chain: "base",
    mode: "B",
    // Mode A reuses this full response as its conviction input (no re-fetch, no double charge)
    captureFullData: true,
  },
  {
    id: "smart-money-screener",
    name: "Smart Money Screener",
    url: getEnvOrDefault("SMART_MONEY_SCREENER_URL", "https://smartmoneyscreener.vercel.app/api/screener/smart-money"),
    method: "GET",
    cost: 0.05,
    chain: "base",
    mode: "B",
  },
  {
    id: "onchain-feed-apac",
    name: "Onchain Intelligence Feed (APAC Daily)",
    url: getEnvOrDefault("ONCHAIN_FEED_APAC_URL", "https://x402oif.vercel.app/api/feed/apac-daily"),
    method: "GET",
    cost: 0.10,
    chain: "base",
    mode: "B",
  },
  {
    id: "onchain-feed-whale",
    name: "Onchain Intelligence Feed (Whale Alert)",
    url: getEnvOrDefault("ONCHAIN_FEED_WHALE_URL", "https://x402oif.vercel.app/api/feed/whale-alert"),
    method: "GET",
    cost: 0.20,
    chain: "base",
    mode: "B",
  },
  {
    id: "odo-funding-nowcast",
    name: "ODO Onchain Funding Nowcast",
    url: getEnvOrDefault("ODO_FUNDING_URL", "https://odo-gamma.vercel.app/funding/nowcast/current"),
    method: "GET",
    cost: 0.01,
    chain: "base",
    mode: "B",
  },
  // ── osd Solana endpoints (manual 402 via Circle DCW Solana wallet) ────────
  // network: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp (Solana mainnet CAIP-2)
  // payTo + amount resolved from 402 challenge (never hardcoded)
  {
    id: "osd-ipo",
    name: "OSD IPO Data (Solana)",
    url: getEnvOrDefault("OSD_IPO_URL", "https://osd-coral.vercel.app/api/ipo"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "B",
  },
  {
    id: "osd-holders",
    name: "OSD Holders Data (Solana)",
    url: getEnvOrDefault("OSD_HOLDERS_URL", "https://osd-coral.vercel.app/api/holders"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "B",
  },
  {
    id: "osd-liquidity",
    name: "OSD Liquidity Data (Solana)",
    url: getEnvOrDefault("OSD_LIQUIDITY_URL", "https://osd-coral.vercel.app/api/liquidity"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "B",
  },
  {
    id: "osd-jin-latest",
    name: "JIN Index Latest (Solana)",
    url: getEnvOrDefault("OSD_JIN_LATEST_URL", "https://jin-orcin-pi.vercel.app/api/jin/latest"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "B",
    captureFullData: true,
  },
  {
    id: "osd-jin-movers",
    name: "JIN Movers (Solana)",
    url: getEnvOrDefault("OSD_JIN_MOVERS_URL", "https://jin-orcin-pi.vercel.app/api/jin/movers"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "B",
    captureFullData: true,
  },
];

export const ENDPOINTS_MODE_C: EndpointConfig[] = [
  {
    id: "apac-macro-weekly",
    name: "APAC Macro Dashboard (Weekly)",
    url: getEnvOrDefault("APAC_MACRO_WEEKLY_URL", "https://x402amd.vercel.app/api/macro/weekly"),
    method: "GET",
    cost: 3.00,
    chain: "base",
    mode: "C",
  },
  {
    id: "yield-intelligence-weekly",
    name: "Yield Intelligence (Weekly)",
    url: getEnvOrDefault("YIELD_INTELLIGENCE_WEEKLY_URL", "https://x402yi.vercel.app/api/yield/weekly"),
    method: "GET",
    cost: 2.00,
    chain: "base",
    mode: "C",
  },
  {
    id: "japan-real-estate-weekly",
    name: "Japan Real Estate Yield (Weekly)",
    url: getEnvOrDefault("JAPAN_REAL_ESTATE_WEEKLY_URL", "https://x402-jrey.vercel.app/api/realestate/weekly"),
    method: "GET",
    cost: 2.00,
    chain: "base",
    mode: "C",
  },
  {
    id: "alpha-memo-weekly",
    name: "Alpha Memo Protocol (Weekly)",
    url: getEnvOrDefault("ALPHA_MEMO_WEEKLY_URL", "https://x402amp.vercel.app/api/memo/weekly"),
    method: "GET",
    cost: 3.00,
    chain: "base",
    mode: "C",
  },
  {
    id: "onchain-feed-weekly",
    name: "Onchain Intelligence Feed (Weekly Report)",
    url: getEnvOrDefault("ONCHAIN_FEED_WEEKLY_URL", "https://x402oif.vercel.app/api/feed/weekly-report"),
    method: "GET",
    cost: 0.50,
    chain: "base",
    mode: "C",
  },
];

/**
 * Mode D — daily consumption of osd's published alpha + track-record endpoints
 * (Onchain Stock Data / AlternaData for agents). Read-only GETs, settled per call
 * in Solana USDC over x402. captureFullData persists each daily snapshot as
 * append-only provenance (the immutable track record).
 *
 * cost is a budget label; the real amount is taken from the 402 challenge and
 * capped by the payment policy (withinMicroUsdcCap). chain is a log label —
 * fetchWithPayment auto-selects the settlement leg from the 402.
 */
const OSD_ALPHA_BASE = process.env.OSD_API_BASE ?? "https://osd-coral.vercel.app";
const alphaUrl = (envName: string, path: string): string =>
  process.env[envName] || `${OSD_ALPHA_BASE}${path}`;

export const ENDPOINTS_MODE_D: EndpointConfig[] = [
  {
    id: "alpha-us-portfolio",
    name: "OSD Alpha — US Portfolio (current 10)",
    url: alphaUrl("ALPHA_US_PORTFOLIO_URL", "/api/alpha/portfolio/current"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "D",
    captureFullData: true,
  },
  {
    id: "alpha-us-scorecard",
    name: "OSD Alpha — US Scorecard (hit-rate vs SPY/QQQ)",
    url: alphaUrl("ALPHA_US_SCORECARD_URL", "/api/alpha/portfolio/scorecard"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "D",
    captureFullData: true,
  },
  {
    id: "alpha-jp-portfolio",
    name: "OSD Alpha — JP Portfolio (current 10)",
    url: alphaUrl("ALPHA_JP_PORTFOLIO_URL", "/api/alpha/jp/portfolio/current"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "D",
    captureFullData: true,
  },
  {
    id: "alpha-jp-scorecard",
    name: "OSD Alpha — JP Scorecard (hit-rate vs benchmark)",
    url: alphaUrl("ALPHA_JP_SCORECARD_URL", "/api/alpha/jp/scorecard"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "D",
    captureFullData: true,
  },
  {
    id: "alpha-jp-catalysts",
    name: "OSD Alpha — JP Catalysts (list)",
    url: alphaUrl("ALPHA_JP_CATALYSTS_URL", "/api/alpha/jp/catalysts"),
    method: "GET",
    cost: 0.01,
    chain: "solana",
    mode: "D",
    captureFullData: true,
  },
];
