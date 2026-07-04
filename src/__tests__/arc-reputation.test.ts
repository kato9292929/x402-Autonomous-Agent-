/**
 * Arc reputation/validation の純ロジック検証(egress 不要):
 *  - score の動的計算(判定済みが無ければ null=記録しない)
 *  - NewFeedback event からの feedbackIndex 抽出
 *  - feedback/validation hash の決定性
 * 実 tx(giveFeedback / validationRequest/Response)は egress 遮断のため Railway で実証。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeReputationScore,
  extractFeedbackIndex,
  feedbackHashOf,
  newFeedbackTopic0,
} from "../erc8004/arc-reputation";
import { hashOf } from "../erc8004/arc-validation";

test("computeReputationScore: hit/partial/miss を動的集計", () => {
  const s = computeReputationScore([
    { status: "hit" },
    { status: "hit" },
    { status: "partial" },
    { status: "miss" },
    { status: "pending" }, // 対象外
    { status: "na" }, // 対象外
  ]);
  assert.ok(s);
  assert.equal(s?.judgedCount, 4);
  assert.deepEqual(s?.breakdown, { hit: 2, partial: 1, miss: 1 });
  // (1+1+0.5+0)/4 = 0.625 → 63
  assert.equal(s?.score, 63);
});

test("computeReputationScore: 判定済みが無ければ null(捏造しない)", () => {
  assert.equal(computeReputationScore([{ status: "pending" }, { status: "na" }]), null);
  assert.equal(computeReputationScore([]), null);
});

test("extractFeedbackIndex: NewFeedback の data 先頭 uint64 を返す", () => {
  const topic0 = newFeedbackTopic0();
  const idx = 5n;
  const data = "0x" + idx.toString(16).padStart(64, "0") + "ff".repeat(32); // 先頭32byte=index
  assert.equal(extractFeedbackIndex([{ topics: [topic0], data }]), "5");
  // topic0 が違えば null
  assert.equal(extractFeedbackIndex([{ topics: ["0xdead"], data }]), null);
  assert.equal(extractFeedbackIndex([]), null);
});

test("hash は決定的で bytes32(0x + 64hex)", () => {
  const a = feedbackHashOf('{"x":1}');
  const b = feedbackHashOf('{"x":1}');
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(feedbackHashOf('{"x":1}'), feedbackHashOf('{"x":2}'));
  assert.match(hashOf("req"), /^0x[0-9a-f]{64}$/);
});
