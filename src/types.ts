// EndpointConfig is defined in config.ts
export interface EndpointResult {
  endpoint: string;
  product: string;
  status: "success" | "degraded" | "error" | "skipped";
  costUsdc: number;
  responsePeek: string;
  txHash?: string;
  /**
   * Network the payment actually settled on, read back from the settlement
   * response — not the `chain` label in the endpoint config. The two can
   * diverge: the seller decides which legs it advertises and the client picks
   * `accepts[0]`, so a config labelled "solana" can settle on Base without
   * anything in the logs saying so.
   */
  settledNetwork?: string;
  error?: string;
  degradedReason?: string;
  durationMs: number;
  fullData?: Record<string, unknown>;
  /** x402 Seller Probe lookup made before paying (probe-gate.ts); a "skip" means nothing was paid. */
  probe?: import("./probe-gate").ProbeCheck;
  /** Whether the paid body carried anything (content-check.ts). Absent when no body came back. */
  content?: import("./content-check").ContentCheck;
  /**
   * The start of the body (JSON, ≤ 1500 chars) when the full body is not kept,
   * so an empty or echo-only answer can be read back from the record.
   */
  bodySample?: string;
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
