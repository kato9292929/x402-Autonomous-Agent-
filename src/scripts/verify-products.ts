/**
 * verify-products.ts
 *
 * One-shot verification of all 11 x402 products (Group 1 + Group 2).
 * Run via Railway Console: ts-node src/scripts/verify-products.ts
 * Or: npm run verify-products
 *
 * Does NOT modify Mode B/C config — runs as a separate one-off probe.
 */
import "dotenv/config";
import { initX402Fetch } from "../x402";
import { detectDegraded } from "../stub-detector";

interface ProbeResult {
  product: string;
  url: string;
  method: string;
  status: "success" | "degraded" | "error" | "skip";
  httpStatus?: number;
  paymentOk: boolean;
  x402Version?: string;
  costUsdc: number;
  degradedReason?: string;
  responseSummary: string;
  errorDetail?: string;
  durationMs: number;
}

async function probe(
  product: string,
  url: string,
  cost: number,
  options: RequestInit = {}
): Promise<ProbeResult> {
  const start = Date.now();
  const method = (options.method ?? "GET").toUpperCase();

  try {
    const { fetchWithPayment } = await import("../x402");
    const res = await fetchWithPayment(url, options);
    const durationMs = Date.now() - start;

    const x402Version = res.headers.get("x-402-version") ??
      res.headers.get("x402-version") ?? undefined;

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      return {
        product, url, method,
        status: "error",
        httpStatus: res.status,
        paymentOk: false,
        x402Version,
        costUsdc: 0,
        responseSummary: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        durationMs,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const detection = detectDegraded(data);
    const responseSummary = JSON.stringify(data).slice(0, 200);

    return {
      product, url, method,
      status: detection.degraded ? "degraded" : "success",
      httpStatus: res.status,
      paymentOk: true,
      x402Version,
      costUsdc: cost,
      degradedReason: detection.degraded ? detection.reason : undefined,
      responseSummary,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isV1 = msg.includes("x402 version: 1") || msg.includes("version\":1");
    return {
      product, url, method,
      status: "error",
      paymentOk: false,
      x402Version: isV1 ? "v1 (rejected)" : undefined,
      costUsdc: 0,
      responseSummary: "",
      errorDetail: msg.slice(0, 400),
      durationMs,
    };
  }
}

async function probeUnknownPath(
  product: string,
  baseUrl: string,
  candidatePaths: string[]
): Promise<ProbeResult> {
  // Try candidate paths without payment first to find a live 402 endpoint
  for (const p of candidatePaths) {
    const url = `${baseUrl}${p}`;
    try {
      const res = await fetch(url);
      if (res.status === 402) {
        // Found a 402 endpoint — now probe with payment
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const accepts = body["accepts"] as unknown[];
        const firstAccept = accepts?.[0] as Record<string, unknown> | undefined;
        const cost = parseFloat(String(firstAccept?.["maxAmountRequired"] ?? "0")) / 1e6;
        console.log(`  [FOUND] ${url} → 402, cost ~$${cost} USDC`);
        return probe(product, url, cost);
      }
      if (res.status !== 404) {
        console.log(`  [INFO] ${url} → HTTP ${res.status}`);
      }
    } catch {
      // network or parse error, try next
    }
  }
  return {
    product,
    url: `${baseUrl} (candidates tried: ${candidatePaths.join(", ")})`,
    method: "GET",
    status: "skip",
    paymentOk: false,
    costUsdc: 0,
    responseSummary: "パス不明 — 候補パス全て 404/不達",
    durationMs: 0,
  };
}

function printTable(results: ProbeResult[]): void {
  console.log("\n" + "═".repeat(120));
  console.log("  PRODUCT VERIFICATION RESULTS");
  console.log("═".repeat(120));

  const COL_W = [35, 8, 10, 8, 9, 60];
  const header = [
    "Product".padEnd(COL_W[0]),
    "Method".padEnd(COL_W[1]),
    "Status".padEnd(COL_W[2]),
    "Pay?".padEnd(COL_W[3]),
    "Cost$".padEnd(COL_W[4]),
    "Response / Error",
  ].join(" │ ");
  console.log(header);
  console.log("─".repeat(120));

  let totalCost = 0;
  for (const r of results) {
    totalCost += r.costUsdc;
    const statusIcon = r.status === "success" ? "✓ success" :
      r.status === "degraded" ? "~ degraded" :
      r.status === "skip" ? "- skip" : "✗ error";
    const payIcon = r.paymentOk ? "v2 ✓" : r.x402Version ? r.x402Version : "✗";
    const detail = r.status === "error"
      ? (r.errorDetail ?? r.responseSummary).slice(0, 60)
      : r.status === "degraded"
      ? `[${r.degradedReason}] ${r.responseSummary.slice(0, 40)}`
      : r.responseSummary.slice(0, 60);

    const row = [
      r.product.slice(0, COL_W[0]).padEnd(COL_W[0]),
      r.method.padEnd(COL_W[1]),
      statusIcon.padEnd(COL_W[2]),
      payIcon.padEnd(COL_W[3]),
      `$${r.costUsdc.toFixed(2)}`.padEnd(COL_W[4]),
      detail,
    ].join(" │ ");
    console.log(row);

    // Print full response for successful calls
    if (r.status === "success" || r.status === "degraded") {
      console.log(`  → ${r.responseSummary.slice(0, 200)}`);
    }
    if (r.status === "error" && r.errorDetail) {
      console.log(`  ✗ ${r.errorDetail.slice(0, 300)}`);
    }
  }

  console.log("─".repeat(120));
  console.log(`  TOTAL COST: $${totalCost.toFixed(2)} USDC across ${results.length} probes`);
  console.log("═".repeat(120) + "\n");
}

async function main(): Promise<void> {
  console.log("[VERIFY] Initializing x402 payment client...");
  await initX402Fetch();
  console.log("[VERIFY] Starting product verification — 11 products\n");

  const results: ProbeResult[] = [];

  // ── GROUP 1: Already in Mode B (Base chain, daily) ─────────────────────────

  console.log("── Group 1: Mode B endpoints ──────────────────────────────────");

  results.push(await probe(
    "APAC Macro Dashboard",
    "https://x402amd.vercel.app/api/macro/dashboard",
    0.30
  ));

  results.push(await probe(
    "Yield Intelligence",
    "https://x402yi.vercel.app/api/yield/scan",
    0.20
  ));

  results.push(await probe(
    "Portfolio Intelligence",
    "https://x402pi.vercel.app/api/portfolio/analyze",
    0.50,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: process.env.PORTFOLIO_ANALYZE_TARGET ?? "0x0000000000000000000000000000000000000000",
        chain: "base",
      }),
    }
  ));

  results.push(await probe(
    "Japan Real Estate Yield",
    "https://x402-jrey.vercel.app/api/realestate/yield?area=tokyo",
    0.30
  ));

  results.push(await probe(
    "Divergence Analyzer",
    "https://x402nansenpolymarket.vercel.app/api/divergence/scan",
    0.15
  ));

  results.push(await probe(
    "Hyperliquid Intelligence",
    "https://x402-hl.vercel.app/api/hyperliquid/scan",
    0.20
  ));

  results.push(await probe(
    "OIF: APAC Daily",
    "https://x402oif.vercel.app/api/feed/apac-daily",
    0.10
  ));

  results.push(await probe(
    "OIF: Whale Alert",
    "https://x402oif.vercel.app/api/feed/whale-alert",
    0.20
  ));

  // ── GROUP 2: Not in Mode B daily ────────────────────────────────────────────

  console.log("\n── Group 2: Unregistered products ─────────────────────────────");

  // Alpha Memo Protocol — daily endpoint (in modeA)
  results.push(await probe(
    "Alpha Memo Protocol (daily)",
    "https://x402amp.vercel.app/api/memo/daily",
    1.00
  ));

  // Whale Intent Decoder — POST decode (in modeA)
  results.push(await probe(
    "Whale Intent Decoder",
    "https://x402wid.vercel.app/api/decode",
    0.30,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ETH", chain: "ethereum", amount: 100000 }),
    }
  ));

  // Smart Money Copy Terminal — POST execute (in modeA, conditional)
  // NOTE: This endpoint may trigger an actual copy-trade execution.
  // We probe with a minimal payload; no live connected exchange wallet is assumed.
  results.push(await probe(
    "Smart Money Copy Terminal",
    "https://x402smct.vercel.app/api/execute",
    0.10,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ETH", chain: "ethereum", amountUsd: 10 }),
    }
  ));

  // APAC Compliance Agent — path unknown; try common patterns
  console.log("\n  [x402aca] Probing candidate paths...");
  results.push(await probeUnknownPath(
    "APAC Compliance Agent",
    "https://x402aca.vercel.app",
    [
      "/api/compliance/scan",
      "/api/compliance/check",
      "/api/agent/check",
      "/api/agent/scan",
      "/api/check",
      "/api/scan",
    ]
  ));

  // ── Print results ────────────────────────────────────────────────────────────
  printTable(results);
}

main().catch((err) => {
  console.error("[VERIFY] Fatal error:", err);
  process.exit(1);
});
