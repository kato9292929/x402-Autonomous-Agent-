/**
 * Tests for the x402 Seller Probe lookup before buying from a third-party seller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProbe, decide } from "../probe-gate";

const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("last paid measurement not_delivered → skip", () => {
  const r = decide("s.example", { score: 80, buyable_without_input: true, last_paid: { outcome: "not_delivered", date: "2026-10-28" } }, "GET");
  assert.equal(r.decision, "skip");
  assert.match(r.reason!, /not_delivered/);
});

test("buyable_without_input false → skip a GET, but not a POST we send a body to", () => {
  const doc = { score: 70, buyable_without_input: false, requires_input_reason: { reason: "requires_input: query: q" }, last_paid: null };
  assert.equal(decide("s.example", doc, "GET").decision, "skip");
  assert.match(decide("s.example", doc, "GET").reason!, /query: q/);
  assert.equal(decide("s.example", doc, "POST").decision, "buy");
});

test("delivered / no data → buy", () => {
  assert.equal(decide("s.example", { score: 90, buyable_without_input: true, last_paid: { outcome: "delivered" } }, "GET").decision, "buy");
  assert.equal(decide("s.example", { score: null, buyable_without_input: null, last_paid: null }, "GET").decision, "buy");
});

test("Probe 404, 5xx or down → buy, lookup recorded", async () => {
  const a = await checkProbe("https://s.example/x", "GET", json(404, {}));
  assert.deepEqual([a.status, a.decision], ["unscored", "buy"]);
  const b = await checkProbe("https://s.example/x", "GET", json(503, {}));
  assert.deepEqual([b.status, b.decision, b.error], ["unavailable", "buy", "HTTP 503"]);
  const c = await checkProbe("https://s.example/x", "GET", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  assert.deepEqual([c.status, c.decision], ["unavailable", "buy"]);
});

test("own sellers (OSD, JIN) are never looked up", async () => {
  let called = false;
  const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  for (const u of ["https://osd-coral.vercel.app/api/ipo", "https://jin-orcin-pi.vercel.app/api/jin/latest", "https://jin.x402jp.com/api/jin/series"]) {
    const r = await checkProbe(u, "GET", f);
    assert.deepEqual([r.status, r.decision], ["own", "buy"]);
  }
  assert.equal(called, false);
});

test("a not_delivered third party is skipped through the real lookup", async () => {
  const r = await checkProbe("https://www.Bad.example/api", "GET", json(200, { last_paid: { outcome: "not_delivered", date: "2026-10-26" } }));
  assert.deepEqual([r.host, r.decision], ["bad.example", "skip"]);
});
