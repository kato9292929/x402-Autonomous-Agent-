/**
 * Tests for the World ID Upstash-backed persistence (approval queue + nullifier
 * replay protection). The Upstash REST API is mocked with an in-memory fake
 * `fetch` that understands the handful of commands we issue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueApproval,
  findPendingItem,
  markApproved,
  listItems,
} from "../world-id/queue";
import { claimNullifier } from "../world-id/nullifier-store";

type FetchFn = typeof globalThis.fetch;

/** Minimal in-memory Redis implementing the commands our code uses. */
function makeFakeRedis(): FetchFn {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  return (async (_url: unknown, init?: { body?: string }) => {
    const cmd = JSON.parse(init?.body ?? "[]") as string[];
    const op = String(cmd[0]).toUpperCase();
    let result: unknown = null;

    if (op === "SET") {
      const [, key, value, ...rest] = cmd;
      const nx = rest.includes("NX");
      if (nx && kv.has(key)) {
        result = null; // NX: key exists → not set
      } else {
        kv.set(key, value);
        result = "OK";
      }
    } else if (op === "GET") {
      result = kv.has(cmd[1]) ? kv.get(cmd[1]) : null;
    } else if (op === "SADD") {
      const s = sets.get(cmd[1]) ?? new Set<string>();
      s.add(cmd[2]);
      sets.set(cmd[1], s);
      result = 1;
    } else if (op === "SREM") {
      sets.get(cmd[1])?.delete(cmd[2]);
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

test("approval lifecycle via Upstash: create → get → approve", async () => {
  await withFakeUpstash(async () => {
    const item = await enqueueApproval();
    assert.equal(item.status, "pending");
    assert.match(item.id, /^\d{8}-[0-9a-f]{8}$/);

    const found = await findPendingItem(item.id);
    assert.ok(found, "pending item should be found");
    assert.equal(found?.id, item.id);

    await markApproved(item.id);

    // No longer pending after approval.
    assert.equal(await findPendingItem(item.id), undefined);

    const all = await listItems();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.status, "approved");
    assert.ok(all[0]?.approvedAt, "approvedAt should be set");
  });
});

test("findPendingItem returns undefined for an unknown id", async () => {
  await withFakeUpstash(async () => {
    assert.equal(await findPendingItem("20260101-deadbeef"), undefined);
  });
});

test("nullifier: second claim of the same (nullifier, action) is rejected (SET NX)", async () => {
  await withFakeUpstash(async () => {
    const action = "approve-mode-c-20260101-aabbccdd";
    const first = await claimNullifier("nullifier-X", action);
    assert.equal(first, true, "first claim should succeed");

    const second = await claimNullifier("nullifier-X", action);
    assert.equal(second, false, "replay of same (nullifier, action) must be rejected");
  });
});

test("nullifier: same nullifier under a different action is allowed", async () => {
  await withFakeUpstash(async () => {
    const a1 = await claimNullifier("nullifier-Y", "approve-mode-c-20260101-aabbccdd");
    const a2 = await claimNullifier("nullifier-Y", "approve-mode-c-20260108-11223344");
    assert.equal(a1, true);
    assert.equal(a2, true, "different action → independent uniqueness");
  });
});
