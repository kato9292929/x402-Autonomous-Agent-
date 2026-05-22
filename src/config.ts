const getEnvOrDefault = (envName: string, defaultUrl: string): string =>
  process.env[envName] || defaultUrl;

export interface EndpointConfig {
  id: string;
  name: string;
  url: string;
  method: "GET" | "POST";
  cost: number;
  chain: "base" | "solana" | "polygon" | "bnb";
  mode: "B" | "C";
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
  },
  {
    id: "hyperliquid-intelligence",
    name: "Hyperliquid Intelligence",
    url: getEnvOrDefault("HYPERLIQUID_INTELLIGENCE_URL", "https://x402-hl.vercel.app/api/hyperliquid/scan"),
    method: "GET",
    cost: 0.20,
    chain: "base",
    mode: "B",
  },
  {
    id: "private-market",
    name: "Private Market Intelligence",
    url: getEnvOrDefault("PRIVATE_MARKET_URL", "https://x402pmi.vercel.app/api/private-market/scan"),
    method: "GET",
    cost: 0.15,
    chain: "base",
    mode: "B",
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
