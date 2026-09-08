import "dotenv/config";
import cron from "node-cron";
import { initX402Fetch, getSolanaPayerAddress } from "./x402";
import { logBalances } from "./balance-guard";
import { setBalanceWarnings } from "./notify";
import { runModeA } from "./modes/modeA";
import { runModeB } from "./modes/modeB";
import { runModeC, queueModeC } from "./modes/modeC";
import { runModeD } from "./modes/modeD";
import { runOsdConsumption } from "./jobs/osd-consumption";
import { runExternalProbe } from "./jobs/external-probe";
import { runCatalystSweep, runEdinetSweep } from "./jobs/catalyst-sweep";
import { runCatalystAutopilot, runEdinetAutopilot } from "./jobs/catalyst-autopilot";
import { startHttpServer } from "./server";

async function dailyRun(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[AGENT] Daily run — ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}`);
  // Advisory: says the wallet balances out loud before spending. Never blocks
  // the run — not knowing the balance is not a reason to skip the day's work.
  const balanceWarnings = await logBalances(getSolanaPayerAddress()).catch(
    (err: unknown) => {
      console.warn(`[BALANCE] check failed: ${String(err)}`);
      return [] as string[];
    }
  );
  setBalanceWarnings(balanceWarnings);
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
  // The HTTP server (dashboard + API) is read-only and does not need the
  // payment layer. Bring it up first and keep it up.
  startHttpServer();

  // Initialising the payment layer touches the Circle API (fetches the entity
  // public key, prepares the signers). A blip there must NOT take down the
  // process: doing so kills the HTTP server that is already listening, Railway
  // restart-loops, and the domain reads "server not found" — a payment problem
  // presenting as a total outage. So a failure here is logged loudly and the
  // service keeps serving; the day's runs then fail per-run (fetchWithPayment
  // throws "not initialized", caught by each cron handler) instead of crashing
  // the whole container.
  let paymentsReady = false;
  try {
    await initX402Fetch();
    paymentsReady = true;
  } catch (err) {
    console.error(
      "[AGENT] x402 payment init FAILED — dashboard stays up, but paid runs " +
        "will be skipped until the next successful deploy/restart:",
      err
    );
  }

  // Mode A + B + osd-consumption: every day at 06:00 JST (21:00 UTC)
  cron.schedule("0 21 * * *", async () => {
    if (!paymentsReady) {
      console.error("[AGENT] Daily run skipped — x402 payment layer is not initialised");
      return;
    }
    try {
      await dailyRun();
    } catch (err) {
      console.error("[AGENT] Daily run failed:", err);
    }
  });

  // Mode C: every Monday at 06:00 JST (21:00 UTC) — queues for human approval
  cron.schedule("0 21 * * 1", async () => {
    if (!paymentsReady) {
      console.error("[AGENT] Weekly run skipped — x402 payment layer is not initialised");
      return;
    }
    try {
      await weeklyRun();
    } catch (err) {
      console.error("[AGENT] Weekly run failed:", err);
    }
  });

  // External probe: every Monday at 09:00 JST (00:00 UTC). Off unless enabled,
  // so it cannot start spending on third parties by merely being deployed.
  if (process.env.PROBE_ENABLED === "true") {
    cron.schedule("0 0 * * 1", async () => {
      if (!paymentsReady) {
        console.error("[PROBE] Weekly sweep skipped — x402 payment layer is not initialised");
        return;
      }
      try {
        await runExternalProbe({ mode: "sweep" });
      } catch (err) {
        console.error("[PROBE] Weekly sweep failed:", err);
      }
    });
  }

  // Catalyst sweep: every Wednesday at 09:00 JST (00:00 UTC) — a slot that does
  // not collide with the daily run (21:00 UTC) or Mode C / probe (Mon).
  // Scheduled at most once, by whichever path enabled it (autopilot on success,
  // or the manual CATALYST_SWEEP_ENABLED flag).
  let catalystScheduled = false;
  const scheduleCatalystWeekly = (): void => {
    if (catalystScheduled) return;
    catalystScheduled = true;
    cron.schedule("0 0 * * 3", async () => {
      if (!paymentsReady) {
        console.error("[CATALYST] Weekly sweep skipped — x402 payment layer is not initialised");
        return;
      }
      try {
        await runCatalystSweep({ mode: "sweep" });
      } catch (err) {
        console.error("[CATALYST] Weekly sweep failed:", err);
      }
    });
    console.log("[CATALYST] Weekly sweep scheduled — Weds 09:00 JST (00:00 UTC)");
  };

  // Autopilot: the agent onboards itself (run0 → 1-ticker mainnet smoke → live)
  // and schedules the weekly sweep on success. Off unless CATALYST_AUTOPILOT=true
  // and payments initialised, so a deploy alone never starts paying. Runs in the
  // background so a slow/paid onboarding never blocks the HTTP server or crons.
  if (process.env.CATALYST_AUTOPILOT === "true" && paymentsReady) {
    console.log("[CATALYST-AUTOPILOT] armed — self-onboarding in the background");
    void runCatalystAutopilot({ onLive: scheduleCatalystWeekly }).catch((err) =>
      console.error("[CATALYST-AUTOPILOT] failed:", err)
    );
  } else if (process.env.CATALYST_SWEEP_ENABLED === "true") {
    // Manual gate: a human confirmed the wiring and just wants the schedule.
    scheduleCatalystWeekly();
  }

  // EDINET sweep: every Thursday at 09:00 JST (00:00 UTC) — its own slot, clear
  // of catalyst (Weds). Same autopilot / manual-gate shape as catalyst.
  let edinetScheduled = false;
  const scheduleEdinetWeekly = (): void => {
    if (edinetScheduled) return;
    edinetScheduled = true;
    cron.schedule("0 0 * * 4", async () => {
      if (!paymentsReady) {
        console.error("[EDINET] Weekly sweep skipped — x402 payment layer is not initialised");
        return;
      }
      try {
        await runEdinetSweep({ mode: "sweep" });
      } catch (err) {
        console.error("[EDINET] Weekly sweep failed:", err);
      }
    });
    console.log("[EDINET] Weekly sweep scheduled — Thu 09:00 JST (00:00 UTC)");
  };

  if (process.env.EDINET_AUTOPILOT === "true" && paymentsReady) {
    console.log("[EDINET-AUTOPILOT] armed — self-onboarding in the background");
    void runEdinetAutopilot({ onLive: scheduleEdinetWeekly }).catch((err) =>
      console.error("[EDINET-AUTOPILOT] failed:", err)
    );
  } else if (process.env.EDINET_SWEEP_ENABLED === "true") {
    scheduleEdinetWeekly();
  }

  console.log("x402 Autonomous Agent started");
  console.log("  Mode A + B + D + osd:      daily   at 06:00 JST (21:00 UTC)");
  console.log("  Mode C:                    Mondays at 06:00 JST (21:00 UTC)");
  console.log(
    `  External probe:            Mondays at 09:00 JST (00:00 UTC) — ${
      process.env.PROBE_ENABLED === "true" ? "enabled" : "disabled (PROBE_ENABLED)"
    }`
  );
  console.log(
    `  Catalyst sweep (Solana):   Weds    at 09:00 JST (00:00 UTC) — ${
      process.env.CATALYST_AUTOPILOT === "true"
        ? "autopilot (self-onboarding)"
        : process.env.CATALYST_SWEEP_ENABLED === "true"
          ? "enabled (manual)"
          : "disabled (CATALYST_AUTOPILOT / CATALYST_SWEEP_ENABLED)"
    }`
  );
  console.log(
    `  EDINET sweep (Solana):     Thu     at 09:00 JST (00:00 UTC) — ${
      process.env.EDINET_AUTOPILOT === "true"
        ? "autopilot (self-onboarding)"
        : process.env.EDINET_SWEEP_ENABLED === "true"
          ? "enabled (manual)"
          : "disabled (EDINET_AUTOPILOT / EDINET_SWEEP_ENABLED)"
    }`
  );

  // A manual paid run cannot proceed if the payment layer never initialised.
  // Skip it with a clear message rather than throwing a "not initialized" error
  // deep in the run.
  const requirePayments = (flag: string): boolean => {
    if (paymentsReady) return true;
    console.error(`[AGENT] ${flag} skipped — x402 payment layer is not initialised`);
    return false;
  };

  if (process.argv.includes("--run-now") && requirePayments("--run-now")) {
    console.log("\n[AGENT] Manual run triggered");
    await dailyRun();
  }

  if (process.argv.includes("--run-weekly") && requirePayments("--run-weekly")) {
    console.log("\n[AGENT] Manual weekly run triggered (queuing for approval)");
    await weeklyRun();
  }

  if (process.argv.includes("--run-osd") && requirePayments("--run-osd")) {
    console.log("\n[AGENT] Manual osd-consumption run triggered");
    await runOsdConsumption();
  }

  // run 0: 課金ゼロ。支払い層が無くても走れる(素の fetch のみ)。
  if (process.argv.includes("--probe-run0")) {
    console.log("\n[AGENT] External probe — run 0 (discovery only, no payments)");
    await runExternalProbe({ mode: "discovery" });
  }

  if (process.argv.includes("--probe-sweep") && requirePayments("--probe-sweep")) {
    console.log("\n[AGENT] External probe — weekly sweep (paid)");
    await runExternalProbe({ mode: "sweep" });
  }

  // 課金ゼロ。一覧取得＋402読みだけ。支払い層が無くても走れる。
  if (process.argv.includes("--catalyst-run0")) {
    console.log("\n[AGENT] Catalyst sweep — run 0 (discovery only, no payments)");
    await runCatalystSweep({ mode: "discovery" });
  }

  if (process.argv.includes("--catalyst-sweep") && requirePayments("--catalyst-sweep")) {
    console.log("\n[AGENT] Catalyst sweep — weekly (paid, Solana)");
    await runCatalystSweep({ mode: "sweep" });
  }

  // 課金ゼロ。一覧取得＋402読みだけ。
  if (process.argv.includes("--edinet-run0")) {
    console.log("\n[AGENT] EDINET sweep — run 0 (discovery only, no payments)");
    await runEdinetSweep({ mode: "discovery" });
  }

  if (process.argv.includes("--edinet-sweep") && requirePayments("--edinet-sweep")) {
    console.log("\n[AGENT] EDINET sweep — weekly (paid, Solana)");
    await runEdinetSweep({ mode: "sweep" });
  }

  if (process.argv.includes("--run-mode-d") && requirePayments("--run-mode-d")) {
    console.log("\n[AGENT] Manual Mode D (osd alpha consumption) run triggered");
    await runModeD();
  }
}

main().catch((err) => {
  console.error("[AGENT] Fatal startup error:", err);
  process.exit(1);
});
