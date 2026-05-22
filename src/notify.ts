import type { RunLog } from "./types";

export async function sendWebhookSummary(log: RunLog): Promise<void> {
  const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL ?? process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const ok = log.results.filter((r) => r.status === "success").length;
  const ng = log.results.filter((r) => r.status === "error").length;
  const date = log.timestamp.slice(0, 10);
  const secs = Math.round(log.durationMs / 1000);
  const label = log.mode === "C" ? "Weekly Report" : "Morning Briefing";

  const lines = [
    `🤖 x402 Autonomous Agent — ${label} (${date})`,
    ``,
    `✅ ${ok} endpoints OK${ng > 0 ? `  ❌ ${ng} errors` : ""}`,
    `💰 Total spent: $${log.totalCostUsdc.toFixed(3)} USDC`,
    `⏱ Execution time: ${secs}s`,
  ];

  if (log.errors.length > 0) {
    lines.push(``, `⚠️ Errors:`);
    log.errors.forEach((e) => lines.push(`  • ${e}`));
  }

  const text = lines.join("\n");
  const isDiscord = Boolean(process.env.DISCORD_WEBHOOK_URL);
  const payload = isDiscord ? { content: text } : { text };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[notify] Webhook failed:", err);
  }
}
