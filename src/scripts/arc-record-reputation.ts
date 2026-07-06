/**
 * Arc の agentId に reputation(feedback) を記録する。validator ウォレットで giveFeedback。
 *
 * score は AA の判断結果(dated catalyst の当否)から動的計算する。判定済み(hit/partial/miss)が
 * 無ければ記録しない(捏造しない)。
 *
 * 実行(Railway):
 *   node dist/scripts/arc-record-reputation.js
 * 必要 env:
 *   CIRCLE_API_KEY_TEST, CIRCLE_ENTITY_SECRET_TEST, CIRCLE_ARC_VALIDATOR_WALLET_ID
 * 任意 env:
 *   ARC_AGENT_ID(未指定なら M0 記録 arc_identity の arc_agent_id、無ければ 845265)
 */
import "dotenv/config";
import { listCatalysts } from "../osd/catalyst-store";
import { listJpCatalysts } from "../osd/jp-catalyst-store";
import { loadDecisions } from "../store/decision-store";
import { loadArcRegistration, saveArcReputation } from "../erc8004/arc-record";
import {
  computeReputationScore,
  computeDecisionActivityScore,
  feedbackHashOf,
  recordFeedback,
  type JudgedItem,
} from "../erc8004/arc-reputation";
import { arcTxUrl } from "../erc8004/arc-contract";

async function resolveAgentId(): Promise<string> {
  if (process.env.ARC_AGENT_ID) return process.env.ARC_AGENT_ID;
  const reg = await loadArcRegistration();
  return reg?.arc_agent_id ?? "845265";
}

async function collectJudged(): Promise<{ items: JudgedItem[]; detail: Array<Record<string, unknown>> }> {
  const us = await listCatalysts().catch(() => []);
  const jp = await listJpCatalysts().catch(() => []);
  const detail: Array<Record<string, unknown>> = [];
  const items: JudgedItem[] = [];
  for (const c of us) {
    items.push({ status: c.status });
    if (["hit", "partial", "miss"].includes(c.status)) detail.push({ id: c.catalyst_id, ticker: c.ticker, status: c.status });
  }
  for (const c of jp) {
    items.push({ status: c.status });
    if (["hit", "partial", "miss"].includes(c.status)) detail.push({ key: c.seed_key, ticker: c.ticker, status: c.status });
  }
  return { items, detail };
}

async function main(): Promise<void> {
  const agentId = await resolveAgentId(); // Arc agentId(feedback 対象。例 845265)
  // score の根拠データは Base 側 Mode A 実績(trade_agent_daily:{baseAgentId})。
  const baseAgentId = process.env.ERC8004_AGENT_ID ?? "55560";

  // ── 優先1: catalyst の当否(hit/partial/miss)があれば正確性 score ────────────
  const { items, detail } = await collectJudged();
  const accuracy = computeReputationScore(items);

  let score: number;
  let tag1: string;
  let breakdown: { hit: number; partial: number; miss: number };
  let feedback: Record<string, unknown>;

  if (accuracy) {
    score = accuracy.score;
    tag1 = "catalyst-accuracy";
    breakdown = accuracy.breakdown;
    feedback = {
      agentId,
      baseAgentId,
      computedAt: new Date().toISOString(),
      source: "aa-catalyst-accuracy",
      formula: "round(mean(hit=1,partial=0.5,miss=0)*100)",
      score: accuracy.score,
      judgedCount: accuracy.judgedCount,
      breakdown: accuracy.breakdown,
      catalysts: detail,
    };
    console.log(
      `[ARC-REP] source=catalyst-accuracy score=${score} (judged=${accuracy.judgedCount}, ` +
        `hit=${accuracy.breakdown.hit} partial=${accuracy.breakdown.partial} miss=${accuracy.breakdown.miss})`
    );
  } else {
    // ── 優先2: 当否がまだ無ければ Mode A 日次判断実績を score 源にする ──────────
    const decisions = await loadDecisions(baseAgentId);
    const activity = computeDecisionActivityScore(decisions);
    if (!activity) {
      console.log(
        "[ARC-REP] catalyst 当否も Mode A decision(trade_agent_daily)も無いため reputation を記録しません(保留)。" +
          " 実データが貯まってから再実行してください(捏造しない)。"
      );
      return;
    }
    score = activity.score;
    tag1 = "mode-a-daily-decision";
    breakdown = { hit: 0, partial: 0, miss: 0 };
    feedback = {
      agentId,
      baseAgentId,
      computedAt: new Date().toISOString(),
      source: "aa-mode-a-daily-decision",
      note: "予測の的中率ではなく Mode A 日次判断の確信度平均。当否確定後は catalyst-accuracy に移行",
      formula: "round(mean(|decision.score|)*100)",
      score: activity.score,
      n: activity.n,
      meanAbsScore: activity.meanAbsScore,
      buyCount: activity.buyCount,
      skipCount: activity.skipCount,
      decisions: decisions.slice(-30).map((d) => ({ date: d.date, score: d.score, action: d.call?.action })),
    };
    console.log(
      `[ARC-REP] source=mode-a-daily-decision score=${score} ` +
        `(n=${activity.n}, meanAbs=${activity.meanAbsScore}, BUY=${activity.buyCount}, SKIP=${activity.skipCount})`
    );
  }

  const feedbackHash = feedbackHashOf(JSON.stringify(feedback));

  const { txHash, feedbackIndex } = await recordFeedback({
    agentId,
    score,
    tag1,
    endpoint: "",
    feedbackURI: "", // 当面 off-chain file は未アップロード。hash のみ紐づけ
    feedbackHash,
  });

  await saveArcReputation({
    chain: "ARC-TESTNET",
    arc_agent_id: agentId,
    score,
    judged_count: (feedback["judgedCount"] as number) ?? (feedback["n"] as number) ?? 0,
    breakdown,
    tag1,
    feedback_hash: feedbackHash,
    tx_hash: txHash,
    feedback_index: feedbackIndex,
    explorer_tx_url: arcTxUrl(txHash),
    recorded_at: new Date().toISOString(),
  });

  console.log(`\n[ARC-REP] feedback tx: ${arcTxUrl(txHash)} (feedbackIndex=${feedbackIndex})`);
  console.log("[ARC-REP] arcscan で tx を Success 確認するまで「記録できた」としないこと。");
}

main().catch((err) => {
  console.error("[ARC-REP] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
