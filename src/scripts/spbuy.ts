/**
 * Runs the Seller Probe–driven external purchase once, by hand.
 *
 *   npm run spbuy              select, pay (≤ $0.01 a call, ≤ SP_BUY_DAILY_USD a day), record
 *   npm run spbuy -- --dry-run select and send the unpaid requests only; pays and saves nothing
 *
 * The same run happens every day with the 06:00 JST purchase (src/index.ts).
 */
import "dotenv/config";
import { runSpBuy } from "../spbuy/run";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const run = await runSpBuy({ dryRun });
  const rows = run.records.map((r) => ({
    host: r.host,
    path: new URL(r.url).pathname,
    category: r.category,
    price: r.price_usd,
    verdict: r.verdict,
    tx: r.tx ?? "",
    reason: r.verdict_reason.slice(0, 80),
  }));
  console.table(rows);
  if (run.notCalled.length) console.table(run.notCalled.map((n) => ({ host: n.host, reason: n.reason })));
  console.log(JSON.stringify({ targets: run.targets, refused: run.refused.length, spentUsd: run.spentUsd }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
