/**
 * verify-products.ts — READ-ONLY product verification
 *
 * Probes 10 read-only x402 endpoints (Group 1 + Group 2 read-only).
 * DOES NOT call any execution endpoint. /api/execute is explicitly blocked.
 *
 * Run: npm run verify-products  (in Railway Console after deploy)
 *
 * Excluded (not probed here):
 *   - x402smct /api/execute  → execution endpoint; may trigger real copy-trade
 *   - x402aca               → not wired in codebase, path unknown
 */
import "dotenv/config";
import { initX402Fetch } from "../x402";
import { detectDegraded } from "../stub-detector";

// ── Safety allowlist ─────────────────────────────────────────────────────────
// Only URLs listed here will be called. Any URL containing "/execute" throws.
const READ_ONLY_ALLOWLIST: ReadonlySet<string> = new Set([
  "https://x402amd.vercel.app/api/macro/dashboard",
  "https://x402yi.vercel.app/api/yield/scan",
  "https://x402pi.vercel.app/api/portfolio/analyze",
  "https://x402-jrey.vercel.app/api/realestate/yield?area=tokyo",
  "https://x402nansenpolymarket.vercel.app/api/divergence/scan",
  "https://x402-hl.vercel.app/api/hyperliquid/scan",
  "https://x402oif.vercel.app/api/feed/apac-daily",
  "https://x402oif.vercel.app/api/feed/whale-alert",
  "https://x402amp.vercel.app/api/memo/daily",
  "https://x402wid.vercel.app/api/decode",
]);

function assertReadOnly(url: string): void {
  if (url.toLowerCase().includes("/execute")) {
    throw new Error(`[SAFETY] Blocked execution endpoint: ${url}`);
  }
  if (!READ_ONLY_ALLOWLIST.has(url.split("?")[0]) && !Array.from(READ_ONLY_ALLOWLIST).some((a) => url.startsWith(a))) {
    throw new Error(`[SAFETY] URL not in read-only allowlist: ${url}`);
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ProbeResult {
  product: string;
  url: string;
  method: string;
  group: 1 | 2;
  status: "success" | "degraded" | "error" | "skipped";
  paymentOk: boolean;
  x402Version?: string;
  costUsdc: number;
  degradedReason?: string;
  responseSummary: string;
  errorDetail?: string;
  durationMs: number;
}

// ── Core probe ───────────────────────────────────────────────────────────────

async function probe(
  product: string,
  group: 1 | 2,
  url: string,
  cost: number,
  options: RequestInit = {}
): Promise<ProbeResult> {
  assertReadOnly(url); // safety gate — throws if execution endpoint

  const start = Date.now();
  const method = (options.method ?? "GET").toUpperCase();
  console.log(`  → ${method} ${url}`);

  try {
    const { fetchWithPayment } = await import("../x402");
    const res = await fetchWithPayment(url, options);
    const durationMs = Date.now() - start;

    const x402Version =
      res.headers.get("x-402-version") ??
      res.headers.get("x402-version") ??
      undefined;

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      return {
        product, url, method, group,
        status: "error",
        paymentOk: false,
        x402Version,
        costUsdc: 0,
        responseSummary: `HTTP ${res.status}: ${text.slice(0, 250)}`,
        durationMs,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const detection = detectDegraded(data);

    return {
      product, url, method, group,
      status: detection.degraded ? "degraded" : "success",
      paymentOk: true,
      x402Version,
      costUsdc: cost,
      degradedReason: detection.degraded ? detection.reason : undefined,
      responseSummary: JSON.stringify(data).slice(0, 300),
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    // Detect v1 rejection
    const isV1 = /x402 version: ?1|"version"\s*:\s*1/.test(msg);
    return {
      product, url, method, group,
      status: "error",
      paymentOk: false,
      x402Version: isV1 ? "v1 (rejected)" : undefined,
      costUsdc: 0,
      responseSummary: "",
      errorDetail: msg.slice(0, 500),
      durationMs,
    };
  }
}

function skipped(product: string, group: 1 | 2, url: string, reason: string): ProbeResult {
  return {
    product, url, method: "—", group,
    status: "skipped",
    paymentOk: false,
    costUsdc: 0,
    responseSummary: reason,
    durationMs: 0,
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

function printResults(results: ProbeResult[]): void {
  console.log("\n" + "═".repeat(130));
  console.log("  x402 PRODUCT VERIFICATION — READ-ONLY");
  console.log("═".repeat(130));

  let totalCost = 0;
  for (const r of results) {
    totalCost += r.costUsdc;

    const icon =
      r.status === "success" ? "✓" :
      r.status === "degraded" ? "~" :
      r.status === "skipped" ? "—" : "✗";

    const payStr = r.paymentOk
      ? `v2 OK ($${r.costUsdc.toFixed(2)})`
      : r.x402Version
      ? r.x402Version
      : r.status === "skipped" ? "—" : "✗ no pay";

    console.log(`\n[G${r.group}] ${icon} ${r.product}`);
    console.log(`     URL    : ${r.url}`);
    console.log(`     Payment: ${payStr}`);

    if (r.status === "success") {
      console.log(`     Content: REAL`);
      console.log(`     Data   : ${r.responseSummary.slice(0, 300)}`);
    } else if (r.status === "degraded") {
      console.log(`     Content: DEGRADED [${r.degradedReason}]`);
      console.log(`     Data   : ${r.responseSummary.slice(0, 300)}`);
    } else if (r.status === "skipped") {
      console.log(`     Note   : ${r.responseSummary}`);
    } else {
      console.log(`     Error  : ${(r.errorDetail ?? r.responseSummary).slice(0, 400)}`);
    }
  }

  console.log("\n" + "─".repeat(130));
  const succeeded = results.filter((r) => r.status === "success" || r.status === "degraded");
  const failed = results.filter((r) => r.status === "error");
  const skippedList = results.filter((r) => r.status === "skipped");

  console.log(`  SUMMARY : ${succeeded.length} paid/responded, ${failed.length} failed, ${skippedList.length} skipped`);
  console.log(`  COST    : $${totalCost.toFixed(2)} USDC total`);
  console.log("\n  Skipped (not probed):");
  console.log("    x402smct /api/execute — 実行系エンドポイントのため未プローブ。挙動は別途監視下で確認");
  console.log("    x402aca  (path unknown) — コード内に未配線・パス不明のため未プローブ");
  console.log("═".repeat(130) + "\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[VERIFY] Initializing x402 payment client (read-only mode)...");
  await initX402Fetch();
  console.log("[VERIFY] Probing 10 read-only endpoints\n");

  const results: ProbeResult[] = [];

  // ── Group 1: Mode B daily (Base chain) ─────────────────────────────────────

  console.log("── Group 1: Mode B daily endpoints ───────────────────────────");

  results.push(await probe("APAC Macro Dashboard", 1,
    "https://x402amd.vercel.app/api/macro/dashboard", 0.30));

  results.push(await probe("Yield Intelligence", 1,
    "https://x402yi.vercel.app/api/yield/scan", 0.20));

  results.push(await probe("Portfolio Intelligence", 1,
    "https://x402pi.vercel.app/api/portfolio/analyze", 0.50,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: process.env.PORTFOLIO_ANALYZE_TARGET ??
          "0x0000000000000000000000000000000000000000",
        chain: "base",
      }),
    }
  ));

  results.push(await probe("Japan Real Estate Yield", 1,
    "https://x402-jrey.vercel.app/api/realestate/yield?area=tokyo", 0.30));

  results.push(await probe("Divergence Analyzer", 1,
    "https://x402nansenpolymarket.vercel.app/api/divergence/scan", 0.15));

  results.push(await probe("Hyperliquid Intelligence", 1,
    "https://x402-hl.vercel.app/api/hyperliquid/scan", 0.20));

  results.push(await probe("OIF: APAC Daily", 1,
    "https://x402oif.vercel.app/api/feed/apac-daily", 0.10));

  results.push(await probe("OIF: Whale Alert", 1,
    "https://x402oif.vercel.app/api/feed/whale-alert", 0.20));

  // ── Group 2: Read-only unregistered products ────────────────────────────────

  console.log("\n── Group 2: Read-only unregistered products ───────────────────");

  results.push(await probe("Alpha Memo Protocol (daily)", 2,
    "https://x402amp.vercel.app/api/memo/daily", 1.00));

  results.push(await probe("Whale Intent Decoder", 2,
    "https://x402wid.vercel.app/api/decode", 0.30,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ETH", chain: "ethereum", amount: 100000 }),
    }
  ));

  // Explicitly skipped — not probed in this script
  results.push(skipped(
    "Smart Money Copy Terminal", 2,
    "https://x402smct.vercel.app/api/execute",
    "実行系エンドポイントのため未プローブ。挙動は別途監視下で確認"
  ));

  results.push(skipped(
    "APAC Compliance Agent", 2,
    "https://x402aca.vercel.app/???",
    "コード内に未配線・パス不明のため未プローブ"
  ));

  printResults(results);
}

main().catch((err) => {
  console.error("[VERIFY] Fatal error:", err);
  process.exit(1);
});
