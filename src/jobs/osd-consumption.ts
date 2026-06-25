/**
 * osd consumption job — exercises osd's live x402 stack daily.
 *
 * Step 1 (priority): Phase A round-trip. Submit one verifiable catalyst from
 *   config/catalysts.json (free), store it, and poll previously-submitted
 *   catalysts whose eval date has passed until osd returns a verdict.
 * Step 2: low-cost paid data consumption (x402) within a per-run budget.
 * Step 3: every call is appended to the provenance/consumption log.
 *
 * Honesty: catalysts are human-authored, machine-verifiable seeds (numeric/
 * dated). The agent never fabricates a catalyst; a seed without a number or a
 * real target date is skipped. Paid data bodies are not parsed — we only record
 * the settlement ref + status as provenance.
 */
import * as fs from "fs";
import * as path from "path";
import { submitCatalyst, getCatalystScore, paidCall } from "../osd/client";
import { saveCatalyst, listCatalysts, isSeedSubmitted } from "../osd/catalyst-store";
import { logConsumption } from "../osd/consumption-log";
import type { CatalystSeed, CatalystRecord, ConsumptionLogEntry } from "../osd/types";

const num = (env: string, def: number): number => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) ? v : def;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readJsonArray<T>(file: string, key: string): T[] {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "config", file), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const arr = parsed[key];
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}

/** A seed is submittable only if it carries a number and a real ISO date. */
export function isVerifiable(seed: CatalystSeed): boolean {
  return (
    typeof seed.description === "string" &&
    /\d/.test(seed.description) &&
    /^\d{4}-\d{2}-\d{2}$/.test(seed.target_date ?? "")
  );
}

async function logCall(
  endpoint: string,
  priceUsd: number,
  network: string,
  ref: string | null,
  status: number
): Promise<void> {
  const entry: ConsumptionLogEntry = {
    endpoint,
    price_usd: priceUsd,
    network,
    tx_or_settlement_ref: ref,
    status,
    ts: new Date().toISOString(),
  };
  await logConsumption(entry);
}

// ── Step 1: Phase A round-trip ───────────────────────────────────────────────

async function submitNewCatalysts(maxSubmit: number): Promise<void> {
  const seeds = readJsonArray<CatalystSeed>("catalysts.json", "catalysts");
  if (seeds.length === 0) {
    console.log("[OSD] Phase A: no seeds in config/catalysts.json — nothing to submit");
    return;
  }

  let submitted = 0;
  for (const seed of seeds) {
    if (submitted >= maxSubmit) break;
    if (!isVerifiable(seed)) {
      console.warn(`[OSD] Phase A: skipping vague seed "${seed.key}" (needs number + target_date)`);
      continue;
    }
    if (await isSeedSubmitted(seed.key)) continue;

    try {
      const res = await submitCatalyst({
        ticker: seed.ticker,
        description: seed.description,
        target_date: seed.target_date,
      });
      const record: CatalystRecord = {
        catalyst_id: res.catalyst_id,
        ticker: seed.ticker,
        description: seed.description,
        target_date: seed.target_date,
        submitted_at: new Date().toISOString(),
        estimated_eval_date: res.estimated_eval_date,
        score_lookup_url: res.score_lookup_url,
        status: "pending",
        seed_key: seed.key,
      };
      await saveCatalyst(record);
      await logCall("/api/alpha/catalyst/submit", 0, "free", null, 201);
      console.log(
        `[OSD] Phase A: submitted catalyst ${res.catalyst_id} (${seed.ticker}) eval≈${res.estimated_eval_date ?? "?"}`
      );
      submitted += 1;
    } catch (err) {
      console.error(`[OSD] Phase A: submit failed for "${seed.key}": ${String(err)}`);
      break; // likely rate-limited; stop submitting this run
    }
  }
}

async function pollPendingCatalysts(): Promise<void> {
  const all = await listCatalysts();
  const now = today();
  const due = all.filter(
    (c) => c.status === "pending" && (!c.estimated_eval_date || c.estimated_eval_date <= now)
  );
  if (due.length === 0) {
    console.log("[OSD] Phase A: no pending catalysts past their eval date");
    return;
  }

  for (const c of due) {
    try {
      const score = await getCatalystScore(c.catalyst_id);
      if (!score) {
        console.warn(`[OSD] Phase A: score 404 for ${c.catalyst_id}`);
        continue;
      }
      if (score.status === "pending") continue;

      const { status: _s, ...evidence } = score;
      const resolved: CatalystRecord = {
        ...c,
        status: score.status as CatalystRecord["status"],
        verdict_evidence: JSON.stringify(evidence).slice(0, 1000),
        resolved_at: new Date().toISOString(),
      };
      await saveCatalyst(resolved);
      console.log(
        `[OSD] Phase A: catalyst ${c.catalyst_id} (${c.ticker}) → ${score.status}`
      );
    } catch (err) {
      console.error(`[OSD] Phase A: score poll failed for ${c.catalyst_id}: ${String(err)}`);
    }
  }
}

// ── Step 2: paid data consumption ────────────────────────────────────────────

async function consumeData(): Promise<void> {
  const cap = num("OSD_DATA_SPEND_CAP_USD", 0.2);
  const tickersPerRun = Math.max(1, num("OSD_DATA_TICKERS_PER_RUN", 1));
  const tickers = readJsonArray<string>("analyst-tickers.json", "tickers");
  let spent = 0;

  const reserve = (price: number): boolean => {
    if (spent + price > cap + 1e-9) return false;
    spent += price; // reserve up front: x402 pays before the response arrives
    return true;
  };

  const data: Array<{ label: string; path: string; price: number; network: string; method?: "GET"; body?: unknown }> = [];

  // Rotate which ticker(s) we exercise so cost stays flat but coverage spreads.
  const dayIdx = Math.floor(Date.now() / 86_400_000);
  for (let i = 0; i < tickersPerRun && tickers.length > 0; i++) {
    const t = tickers[(dayIdx + i) % tickers.length];
    data.push({ label: `/api/stocks/${t}`, path: `/api/stocks/${encodeURIComponent(t)}`, price: 0.01, network: "base" });
  }
  // Solana-only endpoints settle on the Solana leg.
  data.push({ label: "/api/liquidity", path: "/api/liquidity", price: 0.01, network: "solana" });
  data.push({ label: "/api/holders", path: "/api/holders", price: 0.01, network: "solana" });

  for (const call of data) {
    if (!reserve(call.price)) {
      console.log(`[OSD] Step 2: budget cap $${cap.toFixed(2)} reached — skipping ${call.label}`);
      continue;
    }
    try {
      const r = await paidCall(call.path, { method: "GET", expectedNetwork: call.network });
      await logCall(call.label, call.price, r.network, r.settlementRef, r.status);
    } catch (err) {
      console.error(`[OSD] Step 2: ${call.label} failed: ${String(err)}`);
      await logCall(call.label, call.price, call.network, null, 0);
    }
  }

  // Weekly premium: predict quick ($0.50). Gated to one day/week; not counted
  // against the data cap. High tiers (standard/deep) are never called here.
  const premiumDay = num("OSD_PREMIUM_WEEKLY_DAY", 1); // 1 = Monday (UTC)
  if (new Date().getUTCDay() === premiumDay && tickers.length > 0) {
    const t = tickers[dayIdx % tickers.length];
    try {
      const r = await paidCall("/api/predict", {
        body: { tickers: [t], horizon: "1m", depth: "quick" },
        expectedNetwork: "base",
      });
      await logCall("/api/predict", 0.5, r.network, r.settlementRef, r.status);
    } catch (err) {
      console.error(`[OSD] Step 2: weekly predict failed: ${String(err)}`);
      await logCall("/api/predict", 0.5, "base", null, 0);
    }
  }

  console.log(`[OSD] Step 2: data spend this run ≈ $${spent.toFixed(2)} (cap $${cap.toFixed(2)})`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runOsdConsumption(): Promise<void> {
  const start = Date.now();
  console.log("[OSD] Consumption job started");

  try {
    await submitNewCatalysts(Math.max(1, num("OSD_SUBMIT_MAX_PER_RUN", 1)));
    await pollPendingCatalysts();
  } catch (err) {
    console.error(`[OSD] Phase A error: ${String(err)}`);
  }

  try {
    await consumeData();
  } catch (err) {
    console.error(`[OSD] Step 2 error: ${String(err)}`);
  }

  console.log(`[OSD] Consumption job complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}
