/**
 * Analyst job — redirected from US prose notes to JP dated-catalysts.
 *
 * Formerly this posted NVDA/TSLA/AAPL through /api/analyst and generated a
 * prose brief. It now targets the five Japanese AI-datacenter supply-chain
 * names and produces machine-verifiable dated catalysts signed by AA
 * (agentId 55560, market="JP"), tracked to verdict. The export name is kept so
 * the daily-run wiring (and --run-analyst) is unchanged.
 *
 * JP data rule: on-chain endpoints (stocks/liquidity/holders/registry) hold
 * tokenised US equities only, so they are never called here. The only paid
 * per-call source for JP is the news/IR research wrapper (perplexity-research),
 * used for evidence.
 *
 * Submit is gated on osd JP support (前提1: JP-aware judge, 前提3: submit accepts
 * market). Those could not be verified from this environment, so submit is OFF
 * by default (OSD_JP_SUBMIT_ENABLED) — catalysts are recorded locally and submit
 * is a TODO until osd JP support is confirmed.
 */
import * as fs from "fs";
import * as path from "path";
import { submitCatalyst, getCatalystScore, researchEvidence } from "../osd/client";
import { getJpCatalyst, saveJpCatalyst, listJpCatalysts } from "../osd/jp-catalyst-store";
import { logConsumption } from "../osd/consumption-log";
import type { JpCatalystSeed, JpCatalystRecord } from "../osd/types";

const AGENT_ID = 55560;
const EVIDENCE_PRICE_USD = 0.05;

const num = (env: string, def: number): number => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) ? v : def;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readSeeds(): JpCatalystSeed[] {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "config", "jp-catalysts.json"), "utf-8");
    const parsed = JSON.parse(raw) as { catalysts?: JpCatalystSeed[] };
    return Array.isArray(parsed.catalysts) ? parsed.catalysts : [];
  } catch (err) {
    console.error(`[JP-CAT] failed to read config/jp-catalysts.json: ${String(err)}`);
    return [];
  }
}

/** Machine-verifiable only: needs a number in the description and an ISO date. */
function isVerifiable(seed: JpCatalystSeed): boolean {
  return (
    typeof seed.description === "string" &&
    /\d/.test(seed.description) &&
    /^\d{4}-\d{2}-\d{2}$/.test(seed.target_date ?? "")
  );
}

async function generateAndRecord(submitEnabled: boolean): Promise<void> {
  const seeds = readSeeds();
  if (seeds.length === 0) {
    console.warn("[JP-CAT] no seeds in config/jp-catalysts.json");
    return;
  }

  const evidenceCap = num("OSD_JP_EVIDENCE_CAP_USD", 0.3);
  const lookback = num("OSD_JP_EVIDENCE_LOOKBACK_HOURS", 168);
  let evidenceSpent = 0;

  for (const seed of seeds) {
    if (!isVerifiable(seed)) {
      console.warn(`[JP-CAT] skip vague seed "${seed.key}" (needs number + target_date)`);
      continue;
    }

    const existing = await getJpCatalyst(seed.key);
    if (existing && existing.status !== "pending") {
      continue; // already resolved — leave the verdict in place
    }

    // Evidence: one perplexity-research call per ticker, within the run budget.
    let evidence: string | undefined;
    let evidenceRef: string | null | undefined;
    let evidenceTs: string | undefined;
    if (evidenceSpent + EVIDENCE_PRICE_USD <= evidenceCap + 1e-9) {
      evidenceSpent += EVIDENCE_PRICE_USD; // reserve up front (x402 pays first)
      try {
        const r = await researchEvidence(seed.ticker, lookback);
        evidence = JSON.stringify(r.body ?? {}).slice(0, 1500);
        evidenceRef = r.settlementRef;
        evidenceTs = new Date().toISOString();
        await logConsumption({
          endpoint: "/api/wrappers/perplexity-research",
          price_usd: EVIDENCE_PRICE_USD,
          network: r.network,
          tx_or_settlement_ref: r.settlementRef,
          status: r.status,
          ts: evidenceTs,
        });
      } catch (err) {
        console.error(`[JP-CAT] evidence failed for ${seed.ticker}: ${String(err)}`);
        await logConsumption({
          endpoint: "/api/wrappers/perplexity-research",
          price_usd: EVIDENCE_PRICE_USD,
          network: "base",
          tx_or_settlement_ref: null,
          status: 0,
          ts: new Date().toISOString(),
        });
      }
    } else {
      console.log(`[JP-CAT] evidence budget $${evidenceCap.toFixed(2)} reached — skip evidence for ${seed.ticker}`);
    }

    const rec: JpCatalystRecord = {
      seed_key: seed.key,
      ticker: seed.ticker,
      company: seed.company,
      description: seed.description,
      target_date: seed.target_date,
      thesis: seed.thesis,
      conviction: seed.conviction,
      market: "JP",
      agent_id: AGENT_ID,
      status: "pending",
      recorded_at: new Date().toISOString(),
      // keep latest evidence; otherwise preserve any prior snapshot
      evidence: evidence ?? existing?.evidence,
      evidence_ref: evidence !== undefined ? evidenceRef : existing?.evidence_ref,
      evidence_ts: evidence !== undefined ? evidenceTs : existing?.evidence_ts,
      // preserve submission state across runs
      catalyst_id: existing?.catalyst_id,
      submitted_at: existing?.submitted_at,
      estimated_eval_date: existing?.estimated_eval_date,
    };

    if (submitEnabled && !rec.catalyst_id) {
      try {
        const res = await submitCatalyst({
          ticker: seed.ticker,
          description: seed.description,
          target_date: seed.target_date,
          market: "JP",
          source: "aa_jp_coverage",
          conviction: seed.conviction,
          agent_id: AGENT_ID,
        });
        rec.catalyst_id = res.catalyst_id;
        rec.submitted_at = new Date().toISOString();
        rec.estimated_eval_date = res.estimated_eval_date;
        await logConsumption({
          endpoint: "/api/alpha/catalyst/submit",
          price_usd: 0,
          network: "free",
          tx_or_settlement_ref: null,
          status: 201,
          ts: new Date().toISOString(),
        });
        console.log(`[JP-CAT] submitted ${seed.key} (${seed.ticker}) → catalyst_id=${res.catalyst_id} market=JP`);
      } catch (err) {
        console.error(`[JP-CAT] submit failed for ${seed.key}: ${String(err)}`);
      }
    } else if (!submitEnabled) {
      console.log(
        `[JP-CAT] JP submit 廃止(osd 内完結に移行) — "${seed.key}" はローカル記録のみ`
      );
    }

    await saveJpCatalyst(rec);
    console.log(
      `[JP-CAT] ${seed.ticker} ${seed.key} conviction=${seed.conviction} ` +
        `target=${seed.target_date} evidence=${rec.evidence ? "yes" : "no"} ` +
        `${rec.catalyst_id ? `id=${rec.catalyst_id}` : "(local, not submitted)"}`
    );
  }
}

async function pollVerdicts(): Promise<void> {
  const all = await listJpCatalysts();
  const now = today();
  const due = all.filter(
    (c) => c.status === "pending" && c.catalyst_id && (c.estimated_eval_date ?? c.target_date) <= now
  );
  if (due.length === 0) {
    console.log("[JP-CAT] no submitted JP catalysts past their eval date");
    return;
  }
  for (const c of due) {
    try {
      const score = await getCatalystScore(c.catalyst_id!);
      if (!score) {
        console.warn(`[JP-CAT] score 404 for ${c.catalyst_id} (${c.ticker})`);
        continue;
      }
      if (score.status === "pending") continue;
      const { status: _s, ...evidence } = score;
      await saveJpCatalyst({
        ...c,
        status: score.status as JpCatalystRecord["status"],
        verdict_evidence: JSON.stringify(evidence).slice(0, 1000),
        resolved_at: new Date().toISOString(),
      });
      console.log(`[JP-CAT] verdict ${c.ticker} ${c.seed_key} → ${score.status}`);
    } catch (err) {
      console.error(`[JP-CAT] score poll failed for ${c.catalyst_id}: ${String(err)}`);
    }
  }
}

export async function runAnalystDailyNote(): Promise<void> {
  const start = Date.now();
  // 日本株は osd 内完結方式(Claude選定→週次ファイル→CI commit→Vercel配信→期日採点)へ
  // 移行済み。AA からの JP submit は不要になり、二重書き込みを防ぐため恒久無効化する。
  // OSD_JP_SUBMIT_ENABLED が立っていても submit は走らない(env を参照しない)。
  // 生成・evidence・ローカル記録・verdict 追跡は track record として残す。
  const JP_SUBMIT_RETIRED = true;
  const submitEnabled = !JP_SUBMIT_RETIRED && process.env.OSD_JP_SUBMIT_ENABLED === "true";
  console.log(
    `[JP-CAT] JP dated-catalyst job started — submit ${submitEnabled ? "ENABLED" : "DISABLED(日本株は osd 内完結に移行・ローカル記録のみ)"}`
  );

  try {
    await generateAndRecord(submitEnabled);
  } catch (err) {
    console.error(`[JP-CAT] generate error: ${String(err)}`);
  }
  try {
    await pollVerdicts();
  } catch (err) {
    console.error(`[JP-CAT] poll error: ${String(err)}`);
  }

  console.log(`[JP-CAT] Job complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}
