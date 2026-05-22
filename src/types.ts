export interface EndpointConfig {
  name: string;
  url: string;
  path: string;
  costUsdc: number;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

export interface EndpointResult {
  endpoint: string;
  product: string;
  status: "success" | "error";
  costUsdc: number;
  responsePeek: string;
  error?: string;
  durationMs: number;
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
