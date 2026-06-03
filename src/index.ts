import "dotenv/config";
import cron from "node-cron";
import { initX402Fetch } from "./x402";
import { runModeA } from "./modes/modeA";
import { runModeB } from "./modes/modeB";
import { runModeC } from "./modes/modeC";
import { runAnalystDailyNote } from "./jobs/analyst-daily-note";

async function dailyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Daily run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  await runModeB();
  await runModeA();
  await runAnalystDailyNote();
}

async function weeklyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Weekly run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  await runModeC();
}

/**
 * One-off Circle setup tasks, dispatched via the RUN_TASK env var so they can be
 * triggered from the Railway dashboard (Variables) without changing the locked
 * Start Command. Set RUN_TASK=<task>, redeploy, read the logs, then clear it.
 *
 *   RUN_TASK=gen-secret  → print a fresh 32-byte hex Entity Secret
 *   RUN_TASK=register    → register the Entity Secret ciphertext (once)
 *   RUN_TASK=setup       → create the wallet set + wallets (CIRCLE_NETWORKS=BASE for mainnet)
 *   RUN_TASK=verify      → run the Circle × x402 verification (TEST_URL for a live payment)
 *
 * The process exits when the task finishes — it does NOT start the daily agent.
 */
async function runOneOffTask(task: string): Promise<void> {
  switch (task) {
    case "gen-secret": {
      const { generateEntitySecret } = await import(
        "@circle-fin/developer-controlled-wallets"
      );
      console.log("----ENTITY-SECRET----");
      generateEntitySecret();
      console.log("----END----");
      return;
    }
    case "register": {
      await (await import("./scripts/circle-register-entity-secret")).run();
      return;
    }
    case "setup": {
      await (await import("./scripts/circle-setup-wallets")).run();
      return;
    }
    case "verify": {
      await (await import("./scripts/circle-verify")).run();
      return;
    }
    default:
      throw new Error(
        `Unknown RUN_TASK="${task}". Use one of: gen-secret | register | setup | verify.`
      );
  }
}

async function main(): Promise<void> {
  const task = process.env.RUN_TASK?.trim().toLowerCase();
  if (task) {
    console.log(
      `[AGENT] RUN_TASK=${task} — running one-off task (not the daily agent)`
    );
    await runOneOffTask(task);
    console.log(`[AGENT] RUN_TASK=${task} done. Exiting.`);
    process.exit(0);
  }

  await initX402Fetch();

  // Mode A + B + analyst-daily-note: every day at 06:00 JST (21:00 UTC)
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
  console.log("  Mode A + B + analyst-note: daily   at 06:00 JST (21:00 UTC)");
  console.log("  Mode C:                    Mondays at 06:00 JST (21:00 UTC)");

  if (process.argv.includes("--run-now")) {
    console.log("\n[AGENT] Manual run triggered");
    await dailyRun();
  }

  if (process.argv.includes("--run-weekly")) {
    console.log("\n[AGENT] Manual weekly run triggered");
    await weeklyRun();
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
