// EndpointConfig is defined in config.ts
export interface EndpointResult {
  endpoint: string;
  product: string;
  status: "success" | "degraded" | "error" | "skipped";
  costUsdc: number;
  responsePeek: string;
  txHash?: string;
  error?: string;
  degradedReason?: string;
  durationMs: number;
  fullData?: Record<string, unknown>;
  /** x402 Seller Probe lookup made before paying (probe-gate.ts); a "skip" means nothing was paid. */
  probe?: import("./probe-gate").ProbeCheck;
}

export interface RunLog {
  timestamp: string;
  mode: "A" | "B" | "C";
  results: EndpointResult[];
  totalCostUsdc: number;
  totalTxCount: number;
  totalDegradedCount: number;
  durationMs: number;
  errors: string[];
}
