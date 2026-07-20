import "dotenv/config";
import cron from "node-cron";
import { initX402Fetch } from "./x402";
import { runModeA } from "./modes/modeA";
import { runModeB } from "./modes/modeB";
import { runModeC, queueModeC } from "./modes/modeC";
import { runModeD } from "./modes/modeD";
import { runOsdConsumption } from "./jobs/osd-consumption";
import { startHttpServer } from "./server";

async function dailyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Daily run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  const modeBLog = await runModeB();
  await runModeA(modeBLog);
  await runModeD();
  await runOsdConsumption();
}

async function weeklyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Weekly run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  await queueModeC();
}

async function main(): Promise<void> {
  startHttpServer();
  await initX402Fetch();

  // Mode A + B + osd-consumption: every day at 06:00 JST (21:00 UTC)
  cron.schedule("0 21 * * *", async () => {
    try {
      await dailyRun();
    } catch (err) {
      console.error("[AGENT] Daily run failed:", err);
    }
  });

  // Mode C: every Monday at 06:00 JST (21:00 UTC) — queues for human approval
  cron.schedule("0 21 * * 1", async () => {
    try {
      await weeklyRun();
    } catch (err) {
      console.error("[AGENT] Weekly run failed:", err);
    }
  });

  console.log("x402 Autonomous Agent started");
  console.log("  Mode A + B + D + osd:      daily   at 06:00 JST (21:00 UTC)");
  console.log("  Mode C:                    Mondays at 06:00 JST (21:00 UTC)");

  if (process.argv.includes("--run-now")) {
    console.log("\n[AGENT] Manual run triggered");
    await dailyRun();
  }

  if (process.argv.includes("--run-weekly")) {
    console.log("\n[AGENT] Manual weekly run triggered (queuing for approval)");
    await weeklyRun();
  }

  if (process.argv.includes("--run-osd")) {
    console.log("\n[AGENT] Manual osd-consumption run triggered");
    await runOsdConsumption();
  }

  if (process.argv.includes("--run-mode-d")) {
    console.log("\n[AGENT] Manual Mode D (osd alpha consumption) run triggered");
    await runModeD();
  }
}

main().catch((err) => {
  console.error("[AGENT] Fatal startup error:", err);
  process.exit(1);
});
