import "dotenv/config";
import cron from "node-cron";
import { initX402Fetch } from "./x402";
import { runModeA } from "./modes/modeA";
import { runModeB } from "./modes/modeB";
import { runModeC, queueModeC } from "./modes/modeC";
import { runAnalystDailyNote } from "./jobs/analyst-daily-note";
import { startHttpServer } from "./server";

async function dailyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Daily run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  const modeBLog = await runModeB();
  await runModeA(modeBLog);
  await runAnalystDailyNote();
}

function weeklyRun(): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Weekly run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  queueModeC();
}

async function main(): Promise<void> {
  startHttpServer();
  await initX402Fetch();

  // Mode A + B + analyst-daily-note: every day at 06:00 JST (21:00 UTC)
  cron.schedule("0 21 * * *", async () => {
    try {
      await dailyRun();
    } catch (err) {
      console.error("[AGENT] Daily run failed:", err);
    }
  });

  // Mode C: every Monday at 06:00 JST (21:00 UTC) — queues for human approval
  cron.schedule("0 21 * * 1", () => {
    try {
      weeklyRun();
    } catch (err) {
      console.error("[AGENT] Weekly run failed:", err);
    }
  });

  console.log("x402 Autonomous Agent started");
  console.log("  Mode A + B + analyst-note: daily   at 06:00 JST (21:00 UTC)");
  console.log("  Mode C:                    Mondays at 06:00 JST (21:00 UTC)");

  if (process.argv.includes("--run-now")) {
    console.log("\n[AGENT] Manual run triggered");
    await dailyRun();
  }

  if (process.argv.includes("--run-weekly")) {
    console.log("\n[AGENT] Manual weekly run triggered (queuing for approval)");
    weeklyRun();
  }

  if (process.argv.includes("--run-analyst")) {
    console.log("\n[AGENT] Manual analyst-daily-note run triggered");
    await runAnalystDailyNote();
  }
}

main().catch((err) => {
  console.error("[AGENT] Fatal startup error:", err);
  process.exit(1);
});
