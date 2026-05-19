import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runAgent } from "../src/agent.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Protect the endpoint so only Vercel's cron runner can call it
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    await runAgent();
    res.status(200).json({ status: "success", timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Agent run failed:", error);
    res.status(500).json({ error: String(error) });
  }
}
