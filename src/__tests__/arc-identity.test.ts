/**
 * Arc identity のうち egress 不要の純ロジックを検証する:
 *  - receipt.logs からの agentId(tokenId) 抽出
 *  - Arc 登録記録の保存/読み出し(Upstash モック)、Base 55560 と別フィールドであること
 * 実チェーン登録(register/arcscan 確認)は egress 遮断のため別環境で実施する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAgentIdFromLogs } from "../erc8004/arc-executor";
import { saveArcRegistration, loadArcRegistration } from "../erc8004/arc-record";
import { TRANSFER_TOPIC, ZERO_TOPIC, ARC_IDENTITY_REGISTRY } from "../erc8004/arc-contract";

const tokenIdTopic = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const addrTopic = "0x000000000000000000000000ae7c000000000000000000000000000000000001";

test("extractAgentIdFromLogs: mint(Transfer from 0x0)の tokenId を agentId として返す", () => {
  const logs = [
    { address: "0xother", topics: ["0xdeadbeef"], data: "0x" },
    {
      address: ARC_IDENTITY_REGISTRY,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC, addrTopic, tokenIdTopic(42)],
      data: "0x",
    },
  ];
  assert.equal(extractAgentIdFromLogs(logs), "42");
});

test("extractAgentIdFromLogs: mint が無ければ null(捏造しない)", () => {
  // from が 0x0 でない(=通常の transfer)は mint ではない
  const logs = [
    { address: ARC_IDENTITY_REGISTRY, topics: [TRANSFER_TOPIC, addrTopic, addrTopic, tokenIdTopic(7)], data: "0x" },
  ];
  assert.equal(extractAgentIdFromLogs(logs), null);
  assert.equal(extractAgentIdFromLogs([]), null);
});

// ── Upstash モック(record) ────────────────────────────────────────────────────
type FetchFn = typeof globalThis.fetch;
function makeFakeRedis(): FetchFn {
  const kv = new Map<string, string>();
  return (async (_url: unknown, init?: { body?: string }) => {
    const cmd = JSON.parse(init?.body ?? "[]") as string[];
    const op = String(cmd[0]).toUpperCase();
    let result: unknown = null;
    if (op === "SET") { kv.set(cmd[1], cmd[2]); result = "OK"; }
    else if (op === "GET") { result = kv.has(cmd[1]) ? kv.get(cmd[1]) : null; }
    return { ok: true, json: async () => ({ result }) } as unknown as Response;
  }) as FetchFn;
}

test("Arc 登録記録は arc_agent_id で保存され、Base の 55560 と別フィールドで区別される", async () => {
  const origFetch = globalThis.fetch;
  const origUrl = process.env.UPSTASH_REDIS_REST_URL;
  const origToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  globalThis.fetch = makeFakeRedis();
  try {
    await saveArcRegistration({
      chain: "ARC-TESTNET",
      arc_agent_id: "128",
      tx_hash: "0xabc",
      identity_registry: ARC_IDENTITY_REGISTRY,
      metadata_uri: "https://example/agent-card.json",
      explorer_tx_url: "https://testnet.arcscan.app/tx/0xabc",
      base_agent_id: "55560",
      registered_at: new Date().toISOString(),
    });
    const loaded = await loadArcRegistration();
    assert.equal(loaded?.arc_agent_id, "128");
    assert.equal(loaded?.chain, "ARC-TESTNET");
    assert.equal(loaded?.base_agent_id, "55560");
    assert.notEqual(loaded?.arc_agent_id, loaded?.base_agent_id); // 混同しない
  } finally {
    globalThis.fetch = origFetch;
    if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = origUrl;
    if (origToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = origToken;
  }
});
