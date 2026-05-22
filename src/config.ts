import type { EndpointConfig } from "./types";

export const MODE_B_ENDPOINTS: EndpointConfig[] = [
  {
    name: "APAC Macro Dashboard",
    url: process.env.APAC_MACRO_URL ?? "https://x402macro.vercel.app",
    path: "/api/macro/dashboard",
    costUsdc: 0.30,
  },
  {
    name: "Yield Intelligence",
    url: process.env.YIELD_INTEL_URL ?? "https://x402yield.vercel.app",
    path: "/api/yield/scan",
    costUsdc: 0.20,
  },
  {
    name: "Portfolio Intelligence",
    url: process.env.PORTFOLIO_INTEL_URL ?? "https://x402portfolio.vercel.app",
    path: "/api/portfolio/analyze",
    costUsdc: 0.50,
    method: "POST",
    body: { address: process.env.PORTFOLIO_ANALYZE_TARGET ?? "" },
  },
  {
    name: "Japan Real Estate Yield",
    url: "https://apijapan.vercel.app",
    path: "/api/realestate/yield?area=tokyo",
    costUsdc: 0.30,
  },
  {
    name: "Divergence Analyzer",
    url: "https://x402nansenpolymarket.vercel.app",
    path: "/api/divergence/scan",
    costUsdc: 0.15,
  },
  {
    name: "Hyperliquid Intelligence",
    url: process.env.HYPERLIQUID_INTEL_URL ?? "https://x402hyperliquid.vercel.app",
    path: "/api/hyperliquid/positions",
    costUsdc: 0.20,
  },
  {
    name: "Smart Money Screener",
    url: "https://x402smct.vercel.app",
    path: "/api/signals?chain=base",
    costUsdc: 0.05,
  },
  {
    name: "Whale Intent Decoder",
    url: "https://x402wid.vercel.app",
    path: "/api/recent",
    costUsdc: 0.10,
  },
  {
    name: "Japan Data API",
    url: "https://apijapan.vercel.app",
    path: "/api/weather/tokyo",
    costUsdc: 0.005,
  },
  {
    name: "x402 Oracle",
    url: process.env.X402_ORACLE_URL ?? "https://x402oracle.vercel.app",
    path: "/api/oracle/price/btc",
    costUsdc: 0.005,
  },
];

export const MODE_C_ENDPOINTS: EndpointConfig[] = [
  {
    name: "APAC Macro Dashboard Weekly",
    url: process.env.APAC_MACRO_URL ?? "https://x402macro.vercel.app",
    path: "/api/macro/weekly",
    costUsdc: 3.00,
  },
  {
    name: "Yield Intelligence Weekly",
    url: process.env.YIELD_INTEL_URL ?? "https://x402yield.vercel.app",
    path: "/api/yield/weekly",
    costUsdc: 2.00,
  },
  {
    name: "Japan Real Estate Weekly",
    url: "https://apijapan.vercel.app",
    path: "/api/realestate/weekly",
    costUsdc: 2.00,
  },
  {
    name: "Alpha Memo Protocol",
    url: "https://x402amp.vercel.app",
    path: "/api/memo/daily",
    costUsdc: 1.00,
  },
];
