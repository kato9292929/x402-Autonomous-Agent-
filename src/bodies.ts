import * as fs from "fs";
import * as path from "path";

function loadPortfolioTickers(): string[] {
  try {
    const raw = fs.readFileSync(
      path.join(process.cwd(), "config", "portfolio.json"),
      "utf-8"
    );
    return (JSON.parse(raw) as { tickers: string[] }).tickers;
  } catch {
    return ["NVDA", "TSLA", "AAPL"];
  }
}

// POST request body templates keyed by endpoint id
export function getRequestBody(
  endpointId: string
): Record<string, unknown> | undefined {
  const tickers = loadPortfolioTickers();
  const bodies: Record<string, Record<string, unknown>> = {
    "portfolio-intelligence": {
      walletAddress: process.env.PORTFOLIO_ANALYZE_TARGET ?? "",
      chain: "base",
    },
    "birdeye-ohlcv": {
      symbols: tickers,
      type: "1D",
      limit: 30,
    },
    "perplexity-research": {
      tickers,
      lookback_hours: 24,
    },
  };
  return bodies[endpointId];
}
