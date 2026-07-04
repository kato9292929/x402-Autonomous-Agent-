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
import { loadArcRegistration, saveArcReputation } from "../erc8004/arc-record";
import {
  computeReputationScore,
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
  const agentId = await resolveAgentId();
  const { items, detail } = await collectJudged();

  const scored = computeReputationScore(items);
  if (!scored) {
    console.log(
      "[ARC-REP] 判定済み(hit/partial/miss)の catalyst が無いため reputation を記録しません(保留)。" +
        " 判定が確定してから再実行してください(捏造しない)。"
    );
    return;
  }

  const feedback = {
    agentId,
    computedAt: new Date().toISOString(),
    source: "aa-catalyst-accuracy",
    score: scored.score,
    judgedCount: scored.judgedCount,
    breakdown: scored.breakdown,
    catalysts: detail,
  };
  const feedbackHash = feedbackHashOf(JSON.stringify(feedback));

  console.log(
    `[ARC-REP] agentId=${agentId} score=${scored.score} (judged=${scored.judgedCount}, ` +
      `hit=${scored.breakdown.hit} partial=${scored.breakdown.partial} miss=${scored.breakdown.miss})`
  );

  const { txHash, feedbackIndex } = await recordFeedback({
    agentId,
    score: scored.score,
    tag1: "catalyst-accuracy",
    endpoint: "",
    feedbackURI: "", // 当面 off-chain file は未アップロード。hash のみ紐づけ
    feedbackHash,
  });

  await saveArcReputation({
    chain: "ARC-TESTNET",
    arc_agent_id: agentId,
    score: scored.score,
    judged_count: scored.judgedCount,
    breakdown: scored.breakdown,
    tag1: "catalyst-accuracy",
    feedback_hash: feedbackHash,
    tx_hash: txHash,
    feedback_index: feedbackIndex,
    explorer_tx_url: arcTxUrl(txHash),
    recorded_at: new Date().toISOString(),
  });

  console.log(`\n[ARC-REP] feedback tx: ${arcTxUrl(txHash)} (feedbackIndex=${feedbackIndex})`);
  console.log("[ARC-REP] arcscan で tx を確認するまで「記録できた」としないこと。");
}

main().catch((err) => {
  console.error("[ARC-REP] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
