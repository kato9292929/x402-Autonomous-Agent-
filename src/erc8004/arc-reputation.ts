/**
 * ERC-8004 Reputation(Arc Testnet)。
 *
 * validator ウォレット(owner ではない)から ReputationRegistry.giveFeedback を呼び、
 * AA の agentId に score(0-100) を記録する。self-dealing 制約(owner は自分の agent に
 * feedback を付けられない)を守るため必ず validator ウォレットを使う。
 *
 * score は AA の判断結果(dated catalyst の当否)から動的計算する。判定済み(hit/partial/
 * miss)が無ければ null を返し、記録しない(捏造しない)。
 *
 * 関数/event は erc-8004-contracts の ABI で一次確認済み(arc-contract.ts のシグネチャ)。
 */
import { keccak256, toBytes } from "viem";
import {
  ARC_REPUTATION_REGISTRY,
  ARC_GIVE_FEEDBACK_SIG,
  ARC_NEW_FEEDBACK_EVENT,
} from "./arc-contract";
import {
  getValidatorWalletId,
  submitContractExecution,
  waitForTxHash,
  getReceiptLogs,
  type RpcLog,
} from "./arc-tx";

export interface JudgedItem {
  status: string; // "pending" | "hit" | "partial" | "miss" | "na" | ...
}

export interface ReputationScore {
  score: number; // 0-100
  judgedCount: number;
  breakdown: { hit: number; partial: number; miss: number };
}

const WEIGHT: Record<string, number> = { hit: 1, partial: 0.5, miss: 0 };

/**
 * 判定済み catalyst の当否から score(0-100) を動的計算する。
 * 判定済み(hit/partial/miss)が無ければ null(=記録しない)。na/pending は対象外。
 */
export function computeReputationScore(items: JudgedItem[]): ReputationScore | null {
  const judged = items.filter((i) => i.status in WEIGHT);
  if (judged.length === 0) return null;
  const breakdown = { hit: 0, partial: 0, miss: 0 };
  let sum = 0;
  for (const j of judged) {
    sum += WEIGHT[j.status];
    breakdown[j.status as "hit" | "partial" | "miss"] += 1;
  }
  return {
    score: Math.round((sum / judged.length) * 100),
    judgedCount: judged.length,
    breakdown,
  };
}

/** feedback off-chain JSON の keccak256(bytes32, 0x…)。 */
export function feedbackHashOf(feedbackJson: string): string {
  return keccak256(toBytes(feedbackJson));
}

/** NewFeedback event の topic0。 */
export function newFeedbackTopic0(): string {
  return keccak256(toBytes(ARC_NEW_FEEDBACK_EVENT));
}

/**
 * receipt.logs から NewFeedback の feedbackIndex(非indexed data 先頭 uint64)を抽出する純関数。
 * 見つからなければ null。data の最初の 32byte を uint として読む。
 */
export function extractFeedbackIndex(logs: RpcLog[]): string | null {
  const topic0 = newFeedbackTopic0();
  const log = logs.find((l) => l.topics?.[0]?.toLowerCase() === topic0.toLowerCase());
  if (!log?.data || log.data.length < 66) return null;
  const first32 = log.data.slice(2, 66); // 0x を除いた先頭 32byte
  return BigInt("0x" + first32).toString();
}

export interface RecordFeedbackResult {
  txHash: string;
  feedbackIndex: string | null;
}

/**
 * validator ウォレットで giveFeedback を実行する。
 * value=score(int128), valueDecimals=0。tag/endpoint/feedbackURI/feedbackHash は任意。
 */
export async function recordFeedback(input: {
  agentId: string;
  score: number; // 0-100(int)
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: string; // 0x…(bytes32)
}): Promise<RecordFeedbackResult> {
  const zeroHash = "0x" + "0".repeat(64);
  const abiParameters = [
    input.agentId,
    String(Math.trunc(input.score)), // int128 value
    "0", // uint8 valueDecimals
    input.tag1 ?? "",
    input.tag2 ?? "",
    input.endpoint ?? "",
    input.feedbackURI ?? "",
    input.feedbackHash ?? zeroHash,
  ];

  const txId = await submitContractExecution({
    walletId: getValidatorWalletId(), // owner ではなく validator(self-dealing 回避)
    contractAddress: ARC_REPUTATION_REGISTRY,
    abiFunctionSignature: ARC_GIVE_FEEDBACK_SIG,
    abiParameters,
  });
  console.log(`[ARC-REP] giveFeedback submitted: ${txId}`);
  const txHash = await waitForTxHash(txId);
  console.log(`[ARC-REP] tx confirmed: ${txHash}`);
  const logs = await getReceiptLogs(txHash);
  return { txHash, feedbackIndex: extractFeedbackIndex(logs) };
}
