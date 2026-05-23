import "dotenv/config";
import cron from "node-cron";
import { runModeA } from "./modes/modeA";
import { runModeB } from "./modes/modeB";
import { runModeC } from "./modes/modeC";

async function dailyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Daily run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  await runModeB();
  await runModeA();
}

async function weeklyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Weekly run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  await runModeC();
}

async function main(): Promise<void> {
  // Mode A + B: every day at 06:00 JST (21:00 UTC)
  cron.schedule("0 21 * * *", async () => {
    try {
      await dailyRun();
    } catch (err) {
      console.error("[AGENT] Daily run failed:", err);
    }
  });

  // Mode C: every Monday at 06:00 JST (21:00 UTC)
  cron.schedule("0 21 * * 1", async () => {
    try {
      await weeklyRun();
    } catch (err) {
      console.error("[AGENT] Weekly run failed:", err);
    }
  });

  console.log("x402 Autonomous Agent started");
  console.log("  Mode A + B: daily   at 06:00 JST (21:00 UTC)");
  console.log("  Mode C:     Mondays at 06:00 JST (21:00 UTC)");

  if (process.argv.includes("--run-now")) {
    console.log("\n[AGENT] Manual run triggered");
    await dailyRun();
  }

  if (process.argv.includes("--run-weekly")) {
    console.log("\n[AGENT] Manual weekly run triggered");
    await weeklyRun();
  }
}

main().catch((err) => {
  console.error("[AGENT] Fatal startup error:", err);
  process.exit(1);
});
