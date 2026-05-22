// POST request body templates keyed by endpoint id
export function getRequestBody(
  endpointId: string
): Record<string, unknown> | undefined {
  const bodies: Record<string, Record<string, unknown>> = {
    "portfolio-intelligence": {
      walletAddress: process.env.PORTFOLIO_ANALYZE_TARGET ?? "",
      chain: "base",
      riskTolerance: "MEDIUM",
    },
  };
  return bodies[endpointId];
}
