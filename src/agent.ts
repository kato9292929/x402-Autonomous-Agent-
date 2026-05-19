import "dotenv/config";
import { initX402Fetch, fetchWithX402 } from "./x402";

interface Signal {
  token: string;
  chain: string;
  signal: string;
  smartWallets: number;
  netFlowUsd: number;
}

interface SignalsResponse {
  signals?: Signal[];
}

interface DecodeResponse {
  intent: string;
  confidence: number;
}

interface MemoResponse {
  summary?: string;
  highlights?: string[];
}

interface MarketResponse {
  sentiment?: string;
  indices?: Record<string, number>;
}

interface ExecuteResponse {
  status: string;
  txHash?: string;
}

function buildReport(data: {
  topSignal: Signal;
  decoded: DecodeResponse;
  memo: MemoResponse;
  market: MarketResponse;
  executionResult: ExecuteResponse | null;
}): string {
  const { topSignal, decoded, executionResult } = data;
  const executed = executionResult?.status === "executed";
  const flowM = (topSignal.netFlowUsd / 1_000_000).toFixed(2);

  return `
📊 x402 Daily Intelligence Report
🔍 Top Signal: ${topSignal.token} (${topSignal.chain})
💰 Smart Money Net Flow: +$${flowM}M
🐳 Whale Intent: ${decoded.intent} (${Math.round(decoded.confidence * 100)}%)
${executed
    ? `✅ Executed: $10 swap on Base mainnet\nTx: ${executionResult!.txHash}`
    : "⏸ 執行条件未達。監視継続。"}
Powered by Nansen × Claude × x402
  `.trim();
}

export async function runAgent(): Promise<void> {
  console.log(`[${new Date().toISOString()}] x402 Autonomous Agent started`);

  await initX402Fetch();

  // STEP 1: Smart Money Screener — $0.05 USDC
  console.log("[STEP 1] Fetching signals from Smart Money Screener...");
  const signalsRes = await fetchWithX402(
    "https://x402smct.vercel.app/api/signals?chain=base"
  );
  const signalsData = (await signalsRes.json()) as SignalsResponse;

  const strongBuySignals = (signalsData.signals ?? []).filter(
    (s) => s.signal === "BUY" && s.smartWallets >= 5
  );

  if (strongBuySignals.length === 0) {
    console.log("No strong buy signals today. Skipping execution.");
    console.log("📊 x402 Daily Scan: 本日はSTRONG BUYシグナルなし。待機継続。");
    return;
  }

  console.log(`Found ${strongBuySignals.length} strong buy signal(s).`);
  const topSignal = strongBuySignals[0];

  // STEP 2: Whale Intent Decoder — $0.30 USDC
  console.log("[STEP 2] Decoding whale intent...");
  const decodeRes = await fetchWithX402("https://x402wid.vercel.app/api/decode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: topSignal.token,
      chain: topSignal.chain,
      amount: topSignal.netFlowUsd,
    }),
  });
  const decoded = (await decodeRes.json()) as DecodeResponse;
  console.log(`Whale intent: ${decoded.intent} (confidence: ${decoded.confidence})`);

  const intentOk = ["ACCUMULATION", "POSITION_BUILDING"].includes(decoded.intent);

  // STEP 3: Divergence Analyzer — $0.15 USDC
  console.log("[STEP 3] Running divergence analysis...");
  const divergenceRes = await fetchWithX402(
    "https://x402divergence.vercel.app/api/divergence/scan"
  );
  const divergence = await divergenceRes.json();
  console.log("Divergence data:", JSON.stringify(divergence));

  // STEP 4: Alpha Memo Protocol — $1.00 USDC
  console.log("[STEP 4] Fetching daily memo...");
  const memoRes = await fetchWithX402("https://x402amp.vercel.app/api/memo/daily");
  const memo = (await memoRes.json()) as MemoResponse;
  console.log("Memo summary:", memo.summary ?? "(no summary)");

  // STEP 5: Japan Market Bot — auto USDC
  console.log("[STEP 5] Fetching Japan market summary...");
  const marketRes = await fetchWithX402(
    "https://apijapan.vercel.app/api/market/summary"
  );
  const market = (await marketRes.json()) as MarketResponse;
  console.log("Market sentiment:", market.sentiment ?? "(no sentiment)");

  // STEP 6: Execute via Copy Terminal if conditions are met — $0.10 USDC
  let executionResult: ExecuteResponse | null = null;

  if (intentOk && decoded.confidence >= 0.7) {
    console.log("[STEP 6] Conditions met. Executing via Copy Terminal...");
    const executeRes = await fetchWithX402(
      "https://x402smct.vercel.app/api/execute",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: topSignal.token,
          chain: topSignal.chain,
          amountUsd: 10,
        }),
      }
    );
    executionResult = (await executeRes.json()) as ExecuteResponse;
    console.log("Execution result:", JSON.stringify(executionResult));
  } else {
    console.log(
      `[STEP 6] Conditions not met (intentOk=${intentOk}, confidence=${decoded.confidence}). Skipping execution.`
    );
  }

  // STEP 7: Log report
  const report = buildReport({ topSignal, decoded, memo, market, executionResult });
  console.log("\n" + report + "\n");

  console.log(`[${new Date().toISOString()}] Agent run complete`);
}
