/**
 * Reset the EDINET autopilot marker to "unstarted" from one command.
 * The catalyst counterpart's twin — same guard, different surface.
 *
 *   npm run edinet:reset
 */
import "dotenv/config";
import { readAutopilotState, resetAutopilotState } from "../jobs/catalyst-autopilot";
import { EDINET_SURFACE } from "../paycall/surface";
import { upstashConfigured } from "../store/upstash-rest";

async function main(): Promise<void> {
  const before = await readAutopilotState(EDINET_SURFACE);
  console.log(`[EDINET-RESET] current state: ${JSON.stringify(before)}`);
  if (!upstashConfigured()) {
    console.warn(
      "[EDINET-RESET] UPSTASH_REDIS_REST_* is not set — writing only the local " +
        "fallback file, which the deployment does not read. Run this where Upstash is configured."
    );
  }
  await resetAutopilotState(EDINET_SURFACE);
  const after = await readAutopilotState(EDINET_SURFACE);
  console.log(`[EDINET-RESET] reset → ${JSON.stringify(after)}`);
  console.log("[EDINET-RESET] done — the next boot will re-onboard (run0 → smoke → live).");
}

main().catch((err: unknown) => {
  console.error("[EDINET-RESET] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
