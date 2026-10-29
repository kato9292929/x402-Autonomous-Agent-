/**
 * One-time seed of the EDINET sweep that already ran before sweep summaries were
 * persisted (2026-09-10, 197 settlements, $0.197, tx 2LETH…, from the daily log
 * L153-155). It records a real on-chain event that the code did not yet capture,
 * so the dashboard headline shows it now. Every future sweep overwrites it.
 *
 *   npm run seed:edinet-sweep
 *
 * Idempotent: writes to the same key each run.
 */
import "dotenv/config";
import { saveSweepSummary, loadSweepSummaries } from "../store/sweep-summary";
import { upstashConfigured } from "../store/upstash-rest";

async function main(): Promise<void> {
  if (!upstashConfigured()) {
    console.warn(
      "[SEED] UPSTASH_REDIS_REST_* not set — writing the local fallback only, " +
        "which the deployment does not read. Run this where Upstash is configured."
    );
  }
  await saveSweepSummary({
    surface: "edinet",
    at: "2026-09-10T00:06:29.310Z",
    week: "2026-W37",
    settlements: 197,
    totalUsdc: 0.197,
    sampleTx: "2LETHnqxaubdqCvRx7iy9FCMJozNSnJp4djogncg2JQa1ozabD3bsoCnvLs6RR6oWoxoKTsAfhMLZNaSk6nJ3cym",
  });
  const all = await loadSweepSummaries();
  console.log("[SEED] sweep summaries now:", JSON.stringify(all, null, 2));
}

main().catch((err: unknown) => {
  console.error("[SEED] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
