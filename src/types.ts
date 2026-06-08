// EndpointConfig is defined in config.ts
export interface EndpointResult {
  endpoint: string;
  product: string;
  status: "success" | "error";
  costUsdc: number;
  responsePeek: string;
  txHash?: string;
  error?: string;
  durationMs: number;
  fullData?: Record<string, unknown>;
}

export interface RunLog {
  timestamp: string;
  mode: "A" | "B" | "C";
  results: EndpointResult[];
  totalCostUsdc: number;
  totalTxCount: number;
  durationMs: number;
  errors: string[];
}
