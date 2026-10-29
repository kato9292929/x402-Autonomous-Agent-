/**
 * osd submit body が契約どおりのフィールド名で組まれることを検証する。
 * fetch をモックして送信 body をキャプチャする。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { submitCatalyst } from "../osd/client";

type FetchFn = typeof globalThis.fetch;

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

async function withMockFetch(
  responder: (captured: Captured) => { ok: boolean; status: number; json?: unknown; text?: string },
  fn: (calls: Captured[]) => Promise<void>
): Promise<void> {
  const orig = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const captured: Captured = {
      url: String(url),
      body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
    };
    calls.push(captured);
    const r = responder(captured);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  }) as FetchFn;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const okResponse = () => ({
  ok: true,
  status: 201,
  json: { catalyst_id: "cat_1", status: "pending" },
});

test("submit body uses contract field names (catalyst_description, market, source, agent_id string)", async () => {
  await withMockFetch(okResponse, async (calls) => {
    const res = await submitCatalyst({
      ticker: "4062",
      description: "2027年3月期Q1決算で電子事業が増収増益、ASIC向け10%超。",
      target_date: "2026-08-05",
      market: "JP",
      source: "aa_jp_coverage",
      conviction: 0.58,
      agent_id: 55560,
    });
    assert.equal(res.catalyst_id, "cat_1");

    const body = calls[0]!.body;
    // 必須キーが catalyst_description であること (旧 description ではない)
    assert.ok("catalyst_description" in body, "catalyst_description が必須");
    assert.equal(body.catalyst_description, "2027年3月期Q1決算で電子事業が増収増益、ASIC向け10%超。");
    assert.ok(!("description" in body), "誤キー description を送らない");
    assert.equal(body.ticker, "4062");
    assert.equal(body.target_date, "2026-08-05");
    assert.equal(body.market, "JP");
    assert.equal(body.source, "aa_jp_coverage");
    assert.equal(body.conviction, 0.58);
    assert.equal(body.agent_id, "55560"); // 文字列
    assert.equal(typeof body.agent_id, "string");
  });
});

test("US submit (no market) still maps description → catalyst_description", async () => {
  await withMockFetch(okResponse, async (calls) => {
    await submitCatalyst({
      ticker: "NVDA",
      description: "Q2 FY27 total revenue exceeds the guidance high end of $92.8B.",
      target_date: "2026-08-26",
    });
    const body = calls[0]!.body;
    assert.ok("catalyst_description" in body);
    assert.ok(!("market" in body), "market 未指定なら付けない");
    assert.ok(!("source" in body));
  });
});

test("catalyst_description が10字未満なら submit せず例外", async () => {
  await withMockFetch(okResponse, async (calls) => {
    await assert.rejects(
      () => submitCatalyst({ ticker: "X", description: "short", target_date: "2026-08-05" }),
      /catalyst_description must be 10\.\.500/
    );
    assert.equal(calls.length, 0, "範囲外は fetch を呼ばない");
  });
});

test("4xx 応答時に field / message をエラーに含める", async () => {
  const responder = () => ({
    ok: false,
    status: 400,
    text: JSON.stringify({
      error: "validation_error",
      field: "catalyst_description",
      message: "catalyst_description is required",
    }),
  });
  await withMockFetch(responder, async () => {
    await assert.rejects(
      () =>
        submitCatalyst({
          ticker: "4062",
          description: "十分な長さの達成条件本文をここに入れる。",
          target_date: "2026-08-05",
        }),
      /field=catalyst_description/
    );
  });
});
