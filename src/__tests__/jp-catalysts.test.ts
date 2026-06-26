/**
 * Tests for the JP dated-catalyst feature: config validity (machine-verifiable)
 * and the JP catalyst store lifecycle (Upstash mocked).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { saveJpCatalyst, getJpCatalyst, listJpCatalysts } from "../osd/jp-catalyst-store";
import type { JpCatalystRecord, JpCatalystSeed } from "../osd/types";

type FetchFn = typeof globalThis.fetch;

function makeFakeRedis(): FetchFn {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return (async (_url: unknown, init?: { body?: string }) => {
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
    }
    return { ok: true, json: async () => ({ result }) } as unknown as Response;
  }) as FetchFn;
}

async function withFakeUpstash(fn: () => Promise<void>): Promise<void> {
  const origFetch = globalThis.fetch;
  const origUrl = process.env.UPSTASH_REDIS_REST_URL;
  const origToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  globalThis.fetch = makeFakeRedis();
  try {
    await fn();
  } finally {
    globalThis.fetch = origFetch;
    if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = origUrl;
    if (origToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = origToken;
  }
}

test("config/jp-catalysts.json: 5 verifiable JP names with real codes", () => {
  const raw = fs.readFileSync(path.join(process.cwd(), "config", "jp-catalysts.json"), "utf-8");
  const seeds = (JSON.parse(raw) as { catalysts: JpCatalystSeed[] }).catalysts;

  const codes = seeds.map((s) => s.ticker);
  assert.deepEqual(codes.sort(), ["2802", "3110", "4062", "6146", "6920"]);

  for (const s of seeds) {
    assert.ok(/\d/.test(s.description), `${s.key}: description needs a number`);
    assert.match(s.target_date, /^\d{4}-\d{2}-\d{2}$/, `${s.key}: ISO target_date`);
    assert.ok(typeof s.conviction === "number" && s.conviction >= 0 && s.conviction <= 1, `${s.key}: conviction 0..1`);
    assert.ok(s.thesis && s.thesis.length > 0, `${s.key}: thesis present`);
  }
});

function makeRecord(): JpCatalystRecord {
  return {
    seed_key: "ibiden-4062-q1-fy2703",
    ticker: "4062",
    company: "イビデン",
    description: "通期営業利益900億円据え置き以上、ASIC向け10%超",
    target_date: "2026-08-05",
    thesis: "AI-DC 向け基板需要",
    conviction: 0.58,
    market: "JP",
    agent_id: 55560,
    status: "pending",
    recorded_at: new Date().toISOString(),
  };
}

test("JP store: save → get → list, keyed by seed_key (Upstash)", async () => {
  await withFakeUpstash(async () => {
    const rec = makeRecord();
    assert.equal(await getJpCatalyst(rec.seed_key), undefined);
    await saveJpCatalyst(rec);

    const got = await getJpCatalyst(rec.seed_key);
    assert.equal(got?.ticker, "4062");
    assert.equal(got?.market, "JP");
    assert.equal(got?.agent_id, 55560);

    const all = await listJpCatalysts();
    assert.equal(all.length, 1);
  });
});

test("JP store: verdict update overwrites in place (no duplicate)", async () => {
  await withFakeUpstash(async () => {
    const rec = makeRecord();
    await saveJpCatalyst(rec);
    await saveJpCatalyst({ ...rec, status: "hit", catalyst_id: "cat_jp_1", resolved_at: new Date().toISOString() });

    const all = await listJpCatalysts();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.status, "hit");
    assert.equal(all[0]?.catalyst_id, "cat_jp_1");
  });
});
