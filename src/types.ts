// EndpointConfig is defined in config.ts
export interface EndpointResult {
  endpoint: string;
  product: string;
  status: "success" | "degraded" | "error";
  costUsdc: number;
  responsePeek: string;
  txHash?: string;
  error?: string;
  degradedReason?: string;
  durationMs: number;
  fullData?: Record<string, unknown>;
}

export interface RunLog {
  timestamp: string;
  mode: "A" | "B" | "C" | "D";
  results: EndpointResult[];
  totalCostUsdc: number;
  totalTxCount: number;
  totalDegradedCount: number;
  durationMs: number;
  errors: string[];
}
