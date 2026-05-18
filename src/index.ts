import "dotenv/config";
import cron from "node-cron";
import { runAgent } from "./agent";

// 毎朝6時JST = 21時UTC
cron.schedule("0 21 * * *", async () => {
  try {
    await runAgent();
  } catch (error) {
    console.error("Agent run failed:", error);
  }
});

console.log("x402 Autonomous Agent scheduler started");
console.log("Runs daily at 06:00 JST (21:00 UTC)");

if (process.argv.includes("--run-now")) {
  console.log("Manual run triggered");
  runAgent().catch(console.error);
}
