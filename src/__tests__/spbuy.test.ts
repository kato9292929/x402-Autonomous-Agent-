/**
 * The Seller Probe–driven daily purchase: which endpoints are chosen, how the
 * request is rebuilt, what is paid, and how the result is judged.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-spbuy-"));
process.chdir(TMP);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

import { selectTargets, type CuratedItem } from "../spbuy/select";
import { rebuildRequest, runSpBuy, verdictOf } from "../spbuy/run";
import { contentChecks, outputFromPaymentRequired } from "../spbuy/judge";
import type { ProbeClient } from "../probe/client";

const NOW = new Date("2026-11-16T00:00:00Z");
const item = (over: Partial<CuratedItem> & { id: string; host: string }, last: Partial<NonNullable<CuratedItem["last"]>> = {}): CuratedItem => ({
  operator: over.host,
  operator_key: `op:${over.host}`,
  url: `https://${over.host}/a`,
  category: "data",
  reasons: { listed_in: ["most_called"] },
  ...over,
  last: {
    ts: "2026-11-09T13:23:00Z",
    date: "2026-11-09",
    category: "as_described",
    category_label: "納品・説明どおり",
    network: "eip155:8453",
    amount: "2000",
    tx: "0xabc",
    request: { method: "GET", url: `https://${over.host}/a?symbol=AAPL`, query: { symbol: "AAPL" }, body: null, values: [{ in: "query", name: "symbol", value: "AAPL", from: "definition example" }] },
    ...last,
  },
});

test("only Seller Probe's 説明どおり, recent, ≤ $0.01, payable, listed, not ours", () => {
  const items = [
    item({ id: "ok", host: "a.example" }),
    item({ id: "wrong", host: "b.example" }, { category: "not_as_described", category_label: "納品・説明と違う" }),
    item({ id: "old", host: "c.example" }, { ts: "2026-10-20T00:00:00Z", date: "2026-10-20" }),
    item({ id: "dear", host: "d.example" }, { amount: "20000" }),
    item({ id: "arc", host: "e.example" }, { network: "eip155:5042" }),
    item({ id: "unlisted", host: "f.example", reasons: { listed_in: [] } }),
    item({ id: "ours", host: "osd.x402jp.com" }, { request: { method: "GET", url: "https://osd.x402jp.com/api/x" } }),
    item({ id: "noreq", host: "g.example" }, { request: null }),
  ];
  const { targets, refused } = selectTargets(items, new Map(), { today: NOW });
  assert.deepEqual(targets.map((t) => t.id), ["ok"]);
  assert.equal(targets[0].reason.probeDate, "2026-11-09");
  assert.match(targets[0].reason.listed, /一覧表: most_called/);
  const why = Object.fromEntries(refused.map((r) => [r.id, r.reason]));
  assert.match(why.wrong, /説明どおりでない/);
  assert.match(why.old, /古い/);
  assert.match(why.dear, /上限/);
  assert.match(why.arc, /払えないネットワーク/);
  assert.match(why.unlisted, /載っていない/);
  assert.match(why.ours, /自社/);
  assert.match(why.noreq, /要求/);
});

test("at most two per operator, spread across categories", () => {
  const items = [
    ...["1", "2", "3"].map((n) => item({ id: `x${n}`, host: "x.example", operator_key: "op:x", category: "search" }, { amount: `${n}000` })),
    item({ id: "y", host: "y.example", category: "trading" }),
    item({ id: "z", host: "z.example", category: "search" }),
  ];
  const { targets, refused } = selectTargets(items, new Map(), { today: NOW });
  assert.equal(targets.filter((t) => t.operatorKey === "op:x").length, 2);
  assert.ok(refused.some((r) => r.id === "x3" && /上限 2 本/.test(r.reason)), "the dearest third is dropped");
  // Round-robin: the first two targets are of different categories.
  assert.notEqual(targets[0].category, targets[1].category);
});

test("the request is Seller Probe's, with idempotency keys made fresh", () => {
  const { targets } = selectTargets(
    [item({ id: "p", host: "p.example" }, { request: { method: "POST", url: "https://p.example/a?idempotency_key=k1", body: { q: "x", nonce: "n1" }, values: [] } })],
    new Map(),
    { today: NOW }
  );
  const r = rebuildRequest(targets[0]);
  assert.equal(r.method, "POST");
  assert.notEqual(new URL(r.url).searchParams.get("idempotency_key"), "k1");
  assert.equal((r.body as any).q, "x");
  assert.notEqual((r.body as any).nonce, "n1");
  assert.equal(r.values.filter((v) => v.from === "fresh per request").length, 2);
});

test("content checks follow Seller Probe: schema, emptiness, input reflected", () => {
  const output = outputFromPaymentRequired({
    extensions: { bazaar: { info: { output: { type: "json" } }, schema: { properties: { output: { properties: { example: { type: "object", required: ["price"] } } } } } } },
  });
  const ok = contentChecks({ body: Buffer.from('{"symbol":"AAPL","price":1}'), contentType: "application/json", description: null, output, values: [{ name: "symbol", value: "AAPL" }] });
  assert.deepEqual(ok.map((c) => c.result), ["pass", "pass", "pass", "not_checked", "pass"]);
  const bad = contentChecks({ body: Buffer.from('{"symbol":"MSFT"}'), contentType: "application/json", description: null, output, values: [{ name: "symbol", value: "AAPL" }] });
  assert.equal(bad.find((c) => c.name === "output_schema")?.result, "fail");
  assert.equal(bad.find((c) => c.name === "input_reflected")?.result, "fail");
  assert.equal(verdictOf({ status: 200, tx: "t", bodyLength: 10, checks: bad }).verdict, "not_as_described");
  assert.equal(verdictOf({ status: 200, tx: "t", bodyLength: 10, checks: ok }).verdict, "as_described");
  assert.equal(verdictOf({ status: 400, tx: "t", bodyLength: 0, checks: null }).verdict, "paid_then_rejected");
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const challenge = (amount: string, payTo = "0xseller") =>
  new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url: "x" }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount, payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] }) },
  });

test("run: unpaid 402 first, pay within $0.01 and the day's budget, record the verdict", async () => {
  process.env.SP_BUY_DAILY_USD = "0.003";
  const items = [item({ id: "a", host: "a.example", category: "data" }), item({ id: "b", host: "b.example", category: "search" }), item({ id: "c", host: "c.example", category: "analytics" }, { request: { method: "GET", url: "https://c.example/a" } })];
  const paid: string[] = [];
  const client: ProbeClient = {
    fetch: async (u) => {
      paid.push(String(u));
      return new Response('{"symbol":"AAPL","price":1}', {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64({ success: true, transaction: `tx-${paid.length}`, network: "eip155:8453", amount: "2000" }) },
      });
    },
    takeChallenge: () => undefined,
    walletAddress: "0xbuyer",
  };
  const run = await runSpBuy({
    sources: { items, generatedAt: "g", catalog: new Map() },
    fetchImpl: (async (u: string) => (String(u).startsWith("https://c.example") ? new Response("bad", { status: 400 }) : challenge("2000"))) as unknown as typeof fetch,
    client,
    spentToday: 0,
    now: NOW,
  });
  delete process.env.SP_BUY_DAILY_USD;
  assert.equal(paid.length, 1, "$0.003 budget: one $0.002 call, the second would exceed it");
  const a = run.records.find((r) => r.host === "a.example")!;
  assert.equal(a.verdict, "as_described");
  assert.equal(a.tx, "tx-1");
  assert.equal(a.selection.probeVerdict, "納品・説明どおり");
  assert.ok(run.notCalled.some((n) => /予算/.test(n.reason)));
  const c = run.records.find((r) => r.host === "c.example")!;
  assert.equal(c.verdict, "input_mismatch", "no 402 unpaid → not paid");
  assert.equal(c.disagrees, true);
});

test("run: a 402 that pays us, or asks more than $0.01, is not paid", async () => {
  const items = [item({ id: "own", host: "o.example" }), item({ id: "dear", host: "q.example" })];
  let paid = 0;
  const run = await runSpBuy({
    sources: { items, generatedAt: null, catalog: new Map() },
    fetchImpl: (async (u: string) =>
      String(u).includes("o.example") ? challenge("2000", "0xC67d94504696960bA0f2e7C3FeE703950734c00A") : challenge("20000")) as unknown as typeof fetch,
    client: { fetch: async () => { paid++; return new Response("{}"); }, takeChallenge: () => undefined, walletAddress: "w" },
    spentToday: 0,
    now: NOW,
    write: false,
  });
  assert.equal(paid, 0);
  assert.deepEqual(run.records.map((r) => r.verdict_reason).map((r) => /自社|上限/.test(r)), [true, true]);
});

import { sentPaymentFromHeader, signaturesOfWireTx } from "../spbuy/settle-search";

test("payment header: Base gives the EIP-3009 nonce, Solana our signature (not the empty fee-payer slot)", () => {
  const evm = b64({ x402Version: 2, payload: { authorization: { from: "0xae7c", to: "0x9fb3", value: "1000", nonce: "0xabc" }, signature: "0xsig" } });
  assert.deepEqual(sentPaymentFromHeader(evm), { chain: "base", from: "0xae7c", nonce: "0xabc" });
  // wire tx: 2 signature slots, fee payer's empty, ours filled
  const ours = Buffer.alloc(64, 7);
  const wire = Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 0), ours, Buffer.from([1, 2, 3])]);
  const svm = sentPaymentFromHeader(b64({ x402Version: 2, payload: { transaction: wire.toString("base64") } }), "7PVTo");
  assert.equal(svm?.chain, "solana");
  assert.deepEqual(svm && svm.chain === "solana" ? svm.signatures.length : 0, 1);
  assert.equal(signaturesOfWireTx(wire).length, 1);
  assert.equal(sentPaymentFromHeader(null), null);
});

test("run: 200 without a settlement header → the transfer is looked up on chain and counted", async () => {
  const items = [item({ id: "h", host: "h.example" })];
  const header = b64({ x402Version: 2, payload: { authorization: { from: "0xae7c", nonce: "0x01" } } });
  let asked: unknown = null;
  const run = await runSpBuy({
    sources: { items, generatedAt: null, catalog: new Map() },
    fetchImpl: (async () => challenge("2000")) as unknown as typeof fetch,
    client: {
      fetch: async () => new Response('{"symbol":"AAPL","price":1}', { status: 200, headers: { "content-type": "application/json" } }),
      takeChallenge: () => undefined,
      walletAddress: "0xae7c",
      lastPaymentHeader: () => header,
    },
    findSettlement: async (sent) => {
      asked = sent;
      return { tx: "0xfound", source: "onchain_search" as const };
    },
    spentToday: 0,
    now: NOW,
    write: false,
  });
  assert.deepEqual(asked, { chain: "base", from: "0xae7c", nonce: "0x01" });
  const r = run.records[0];
  assert.equal(r.tx, "0xfound");
  assert.equal(r.tx_source, "onchain_search");
  assert.equal(r.verdict, "as_described");
  assert.match(r.verdict_reason, /header missing/);
  assert.equal(run.spentUsd, 0.002);
});

import { applyReconciled } from "../spbuy/reconciled";

test("transfers found on chain afterwards are laid over the stored run, not written into it", () => {
  const rec = {
    url: "https://glim.sh/api/v1/web/fetch", tx: null, http_status: 200, response_bytes: 100,
    checks: [{ name: "not_empty", result: "pass", detail: "100 bytes" }], verdict: "not_settled",
  } as any;
  const run = { date: "2026-11-16", spentUsd: 0.15, records: [rec] } as any;
  const out = applyReconciled(run);
  assert.equal(out.records[0].verdict, "as_described");
  assert.equal(out.records[0].tx_source, "onchain_search");
  assert.equal(out.spentUsd, 0.152);
  assert.equal(run.records[0].tx, null, "the stored run is untouched");
  assert.equal(applyReconciled({ ...run, date: "2026-11-17" }).records[0].tx, null, "other days unaffected");
});
