/**
 * Reset the catalyst autopilot marker to "unstarted" from one command.
 *
 * The autopilot halts at stage "smoking" when a smoke test ended ambiguously (a
 * payment MAY have settled), so it never silently re-pays. Once a human has
 * checked Solscan and knows no funds are stranded, this clears the marker and
 * the next boot re-onboards.
 *
 *   npm run catalyst:reset
 *
 * Writes to Upstash when configured (the durable store the autopilot reads) and
 * to the local fallback file. Prints the state before and after.
 */
import "dotenv/config";
import { readAutopilotState, resetAutopilotState } from "../jobs/catalyst-autopilot";
import { upstashConfigured } from "../store/upstash-rest";

async function main(): Promise<void> {
  const before = await readAutopilotState();
  console.log(`[CATALYST-RESET] current state: ${JSON.stringify(before)}`);
  if (!upstashConfigured()) {
    console.warn(
      "[CATALYST-RESET] UPSTASH_REDIS_REST_* is not set — writing only the local " +
        "fallback file, which the deployment does not read. Run this where Upstash is configured."
    );
  }
  await resetAutopilotState();
  const after = await readAutopilotState();
  console.log(`[CATALYST-RESET] reset → ${JSON.stringify(after)}`);
  console.log("[CATALYST-RESET] done — the next boot will re-onboard (run0 → smoke → live).");
}

main().catch((err: unknown) => {
  console.error("[CATALYST-RESET] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
