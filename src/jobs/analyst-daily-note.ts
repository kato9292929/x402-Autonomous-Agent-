import * as fs from "fs";
import * as path from "path";
import { generateNoteArticle } from "../lib/note-generator";

interface TickerResult {
  ticker: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

async function fetchAnalyst(
  ticker: string,
  baseUrl: string,
  apiKey: string
): Promise<TickerResult> {
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(`${baseUrl}/api/analyst`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": apiKey,
      },
      body: JSON.stringify({ ticker, depth: "standard" }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return { ticker, ok: true, data, durationMs: Date.now() - startMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ticker, ok: false, error, durationMs: Date.now() - startMs };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAnalystDailyNote(): Promise<void> {
  const jobStart = Date.now();
  const date = today();
  console.log(`[ANALYST-NOTE] Job started — ${date}`);

  // Read ticker list
  const tickerConfigPath = path.join(process.cwd(), "config", "analyst-tickers.json");
  let tickers: string[];
  try {
    const raw = fs.readFileSync(tickerConfigPath, "utf-8");
    tickers = (JSON.parse(raw) as { tickers: string[] }).tickers;
  } catch (err) {
    console.error(`[ANALYST-NOTE] Failed to read ticker config: ${err}`);
    return;
  }

  const baseUrl =
    process.env.ANALYST_API_BASE ?? "https://osd-coral.vercel.app";
  const apiKey = process.env.INTERNAL_API_KEY ?? "";

  if (!apiKey) {
    console.error("[ANALYST-NOTE] INTERNAL_API_KEY is not set");
    return;
  }

  // Step 2: Call Analyst for all tickers in parallel
  console.log(`[ANALYST-NOTE] Fetching ${tickers.length} tickers in parallel`);
  const results = await Promise.all(
    tickers.map((t) => fetchAnalyst(t, baseUrl, apiKey))
  );

  // Log per-ticker results
  for (const r of results) {
    if (r.ok) {
      console.log(`[ANALYST-NOTE] ✓ ${r.ticker} (${r.durationMs}ms)`);
    } else {
      console.error(`[ANALYST-NOTE] ✗ ${r.ticker} — ${r.error} (${r.durationMs}ms)`);
    }
  }

  // Step 3: Save raw data per ticker
  const runDir = path.join(process.cwd(), "data", "analyst-runs", date);
  ensureDir(runDir);

  for (const r of results) {
    if (r.ok && r.data) {
      const filePath = path.join(runDir, `${r.ticker}.json`);
      fs.writeFileSync(filePath, JSON.stringify(r.data, null, 2), "utf-8");
      console.log(`[ANALYST-NOTE] Saved raw data: ${filePath}`);
    }
  }

  // Step 4 & 5: Generate and save article
  const successResults = results.filter((r) => r.ok && r.data);
  if (successResults.length === 0) {
    console.error("[ANALYST-NOTE] ERROR: All tickers failed — skipping article generation");
    return;
  }

  console.log(
    `[ANALYST-NOTE] Generating article from ${successResults.length}/${tickers.length} tickers`
  );

  let article: string;
  try {
    article = await generateNoteArticle(
      date,
      successResults.map((r) => ({ ticker: r.ticker, data: r.data! }))
    );
  } catch (err) {
    console.error(`[ANALYST-NOTE] Claude API error: ${err}`);
    return;
  }

  const notesDir = path.join(process.cwd(), "data", "daily-notes");
  ensureDir(notesDir);

  const notePath = path.join(notesDir, `${date}.md`);
  const header = `# AA Daily Brief - ${date}\n\n`;
  fs.writeFileSync(notePath, header + article, "utf-8");

  const charCount = (header + article).length;
  console.log(
    `[ANALYST-NOTE] Article saved: ${notePath} (${charCount} chars)`
  );
  console.log(
    `[ANALYST-NOTE] Job complete in ${((Date.now() - jobStart) / 1000).toFixed(1)}s`
  );
}
