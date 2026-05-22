import { fetchWithX402 } from "../x402";
import type { RunLog } from "../types";
import { logRun } from "../logger";

interface Signal {
  token: string;
  chain: string;
  signal: string;
  smartWallets: number;
  netFlowUsd: number;
}

export async function runModeA(): Promise<void> {
  const startMs = Date.now();
  console.log("[MODE A] Signal-driven run started");

  const log: RunLog = {
    timestamp: new Date().toISOString(),
    mode: "A",
    results: [],
    totalCostUsdc: 0,
    totalTxCount: 0,
    durationMs: 0,
    errors: [],
  };

  try {
    // STEP 1: Smart Money Screener — $0.05
    const signalsRes = await fetchWithX402(
      "https://x402smct.vercel.app/api/signals?chain=base"
    );
    const signalsData = (await signalsRes.json()) as { signals?: Signal[] };
    log.results.push({ endpoint: "/api/signals", product: "Smart Money Screener", status: "success", costUsdc: 0.05, responsePeek: "", durationMs: 0 });
    log.totalCostUsdc += 0.05;
    log.totalTxCount += 1;

    const strongBuys = (signalsData.signals ?? []).filter(
      (s) => s.signal === "BUY" && s.smartWallets >= 5
    );

    if (strongBuys.length === 0) {
      console.log("[MODE A] No strong buy signals. Exiting early.");
      log.durationMs = Date.now() - startMs;
      logRun(log);
      return;
    }

    console.log(`[MODE A] ${strongBuys.length} STRONG BUY signal(s) found`);
    const top = strongBuys[0];

    // STEP 2: Whale Intent Decoder — $0.30
    const decodeRes = await fetchWithX402("https://x402wid.vercel.app/api/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: top.token, chain: top.chain, amount: top.netFlowUsd }),
    });
    const decoded = (await decodeRes.json()) as { intent: string; confidence: number };
    log.results.push({ endpoint: "/api/decode", product: "Whale Intent Decoder", status: "success", costUsdc: 0.30, responsePeek: JSON.stringify(decoded).slice(0, 120), durationMs: 0 });
    log.totalCostUsdc += 0.30;
    log.totalTxCount += 1;

    // STEP 3: Divergence Analyzer — $0.15
    const divRes = await fetchWithX402("https://x402nansenpolymarket.vercel.app/api/divergence/scan");
    const divergence = (await divRes.json()) as Record<string, unknown>;
    log.results.push({ endpoint: "/api/divergence/scan", product: "Divergence Analyzer", status: "success", costUsdc: 0.15, responsePeek: JSON.stringify(divergence).slice(0, 120), durationMs: 0 });
    log.totalCostUsdc += 0.15;
    log.totalTxCount += 1;

    // STEP 4: Alpha Memo Protocol — $1.00
    const memoRes = await fetchWithX402("https://x402amp.vercel.app/api/memo/daily");
    const memo = (await memoRes.json()) as Record<string, unknown>;
    log.results.push({ endpoint: "/api/memo/daily", product: "Alpha Memo Protocol", status: "success", costUsdc: 1.00, responsePeek: JSON.stringify(memo).slice(0, 120), durationMs: 0 });
    log.totalCostUsdc += 1.00;
    log.totalTxCount += 1;

    // STEP 5: Execute if conditions met — $0.10
    const intentOk = ["ACCUMULATION", "POSITION_BUILDING"].includes(decoded.intent);
    if (intentOk && decoded.confidence >= 0.7) {
      console.log("[MODE A] Conditions met. Executing...");
      const execRes = await fetchWithX402("https://x402smct.vercel.app/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: top.token, chain: top.chain, amountUsd: 10 }),
      });
      const execResult = (await execRes.json()) as Record<string, unknown>;
      log.results.push({ endpoint: "/api/execute", product: "Copy Terminal", status: "success", costUsdc: 0.10, responsePeek: JSON.stringify(execResult).slice(0, 120), durationMs: 0 });
      log.totalCostUsdc += 0.10;
      log.totalTxCount += 1;
      console.log("[MODE A] Execution result:", JSON.stringify(execResult));
    } else {
      console.log(`[MODE A] Conditions not met (intent=${decoded.intent}, confidence=${decoded.confidence})`);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.errors.push(error);
    console.error("[MODE A] Error:", error);
  }

  log.durationMs = Date.now() - startMs;
  logRun(log);
  console.log(`[MODE A] Complete. $${log.totalCostUsdc.toFixed(2)} USDC spent`);
}
