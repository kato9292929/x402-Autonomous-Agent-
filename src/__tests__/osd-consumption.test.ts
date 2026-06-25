/**
 * Tests for the osd consumption job: catalyst store lifecycle (Upstash mocked),
 * the consumption log, and the catalyst verifiability gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveCatalyst, listCatalysts, isSeedSubmitted } from "../osd/catalyst-store";
import { logConsumption } from "../osd/consumption-log";
import { isVerifiable } from "../jobs/osd-consumption";
import type { CatalystRecord } from "../osd/types";

type FetchFn = typeof globalThis.fetch;

/** Minimal in-memory Redis for the commands these stores issue. */
function makeFakeRedis(): { fetch: FetchFn; lists: Map<string, string[]> } {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const lists = new Map<string, string[]>();

  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    const cmd = JSON.parse(init?.body ?? "[]") as string[];
    const op = String(cmd[0]).toUpperCase();
    let result: unknown = null;
    if (op === "SET") {
      kv.set(cmd[1], cmd[2]);
      result = "OK";
    } else if (op === "GET") {
      result = kv.has(cmd[1]) ? kv.get(cmd[1]) : null;
    } else if (op === "SADD") {
      const s = sets.get(cmd[1]) ?? new Set<string>();
      s.add(cmd[2]);
      sets.set(cmd[1], s);
      result = 1;
    } else if (op === "SMEMBERS") {
      result = Array.from(sets.get(cmd[1]) ?? []);
    } else if (op === "RPUSH") {
      const l = lists.get(cmd[1]) ?? [];
      l.push(cmd[2]);
      lists.set(cmd[1], l);
      result = l.length;
    }
    return { ok: true, json: async () => ({ result }) } as unknown as Response;
  }) as FetchFn;

  return { fetch: fetchFn, lists };
}

async function withFakeUpstash(
  fn: (lists: Map<string, string[]>) => Promise<void>
): Promise<void> {
  const origFetch = globalThis.fetch;
  const origUrl = process.env.UPSTASH_REDIS_REST_URL;
  const origToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const fake = makeFakeRedis();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  globalThis.fetch = fake.fetch;
  try {
    await fn(fake.lists);
  } finally {
    globalThis.fetch = origFetch;
    if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = origUrl;
    if (origToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = origToken;
  }
}

function makeRecord(): CatalystRecord {
  return {
    catalyst_id: "cat_123",
    ticker: "NVDA",
    description: "FQ3 revenue up >50% YoY",
    target_date: "2026-11-19",
    submitted_at: new Date().toISOString(),
    estimated_eval_date: "2026-11-20",
    status: "pending",
    seed_key: "nvda-fq3-2026",
  };
}

test("catalyst store: save → list → seed dedupe (Upstash)", async () => {
  await withFakeUpstash(async () => {
    const rec = makeRecord();
    assert.equal(await isSeedSubmitted(rec.seed_key!), false);

    await saveCatalyst(rec);

    const all = await listCatalysts();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.catalyst_id, "cat_123");
    assert.equal(all[0]?.status, "pending");

    assert.equal(await isSeedSubmitted(rec.seed_key!), true);
  });
});

test("catalyst store: verdict update overwrites in place", async () => {
  await withFakeUpstash(async () => {
    const rec = makeRecord();
    await saveCatalyst(rec);
    await saveCatalyst({ ...rec, status: "hit", verdict_evidence: "{...}", resolved_at: new Date().toISOString() });

    const all = await listCatalysts();
    assert.equal(all.length, 1, "update must not duplicate the record");
    assert.equal(all[0]?.status, "hit");
  });
});

test("consumption log: pushes one entry to the Upstash list", async () => {
  await withFakeUpstash(async (lists) => {
    await logConsumption({
      endpoint: "/api/stocks/NVDA",
      price_usd: 0.01,
      network: "base",
      tx_or_settlement_ref: "0xdeadbeef",
      status: 200,
      ts: new Date().toISOString(),
    });
    const list = lists.get("osd_consumption_log") ?? [];
    assert.equal(list.length, 1);
    const entry = JSON.parse(list[0]!) as { endpoint: string; tx_or_settlement_ref: string };
    assert.equal(entry.endpoint, "/api/stocks/NVDA");
    assert.equal(entry.tx_or_settlement_ref, "0xdeadbeef");
  });
});

test("catalyst gate: rejects vague seeds, accepts numeric + dated ones", () => {
  assert.equal(
    isVerifiable({ key: "k", ticker: "NVDA", description: "AI revenue +50% YoY", target_date: "2026-11-19" }),
    true
  );
  // no number
  assert.equal(
    isVerifiable({ key: "k", ticker: "NVDA", description: "stock goes up a lot", target_date: "2026-11-19" }),
    false
  );
  // no real date
  assert.equal(
    isVerifiable({ key: "k", ticker: "NVDA", description: "up 50%", target_date: "soon" }),
    false
  );
});
