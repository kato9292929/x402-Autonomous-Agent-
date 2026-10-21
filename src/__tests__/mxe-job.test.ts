/**
 * MXE job pieces that run without a cluster: the public comparison sides, the
 * intake's validation and rate limit, the function 5 catalog, the payment-leg
 * gate, the internal seller route, and the job's behaviour when the MXE is not
 * reachable (recorded as failed — no computation id, no substitute result).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { publicNegotiation, publicRfq } from "../mxe/compare";
import { RateLimiter } from "../mxe/rate-limit";
import { parseSealedRating } from "../mxe/api";
import { catalogOf, knownEndpoints, CATEGORY } from "../mxe/catalog";
import { plainSearch } from "../mxe/functions";
import { slotFor } from "../mxe/slots";
import { isExpectedLeg } from "../mxe/buyer";
import { handleMxeSell, openTrade, SOLANA_MAINNET, SOLANA_USDC_MINT } from "../mxe/seller";
import { devnetRpcUrl, runMxeJob } from "../jobs/mxe-trades";
import type { PaymentRequirements } from "@x402/core/types";

test("public negotiation deals iff the limits overlap, and discloses every offer", () => {
  const deal = publicNegotiation(3000n, 7000n);
  assert.equal(deal.matched, true);
  assert.ok(deal.priceMicro >= 3000n && deal.priceMicro <= 7000n);
  assert.equal(deal.offers.length, deal.rounds * 2);
  const none = publicNegotiation(6000n, 4000n);
  assert.equal(none.matched, false);
  assert.equal(none.offers.at(-2)!.micro, 6000n, "the seller ends at its floor — visible to the buyer");
  assert.equal(none.offers.at(-1)!.micro, 4000n);
  assert.equal(publicNegotiation(5000n, 5000n).matched, true);
  // Large limits still converge before the round cap.
  assert.equal(publicNegotiation(1_000_000n, 1_000_001n).matched, true);
});

test("public RFQ: lowest wins, first on a tie, every quote disclosed", () => {
  const r = publicRfq([
    { seller: "a", micro: 700n },
    { seller: "b", micro: 400n },
    { seller: "c", micro: 400n },
  ]);
  assert.equal(r.winner, "b");
  assert.equal(r.priceMicro, 400n);
  assert.equal(r.quotes.length, 3);
});

test("rate limiter: per client per window, and overall", () => {
  let t = 0;
  const l = new RateLimiter({ perClient: 2, perClientWindowMs: 1000, global: 3, globalWindowMs: 10_000 }, () => t);
  assert.equal(l.take("a").ok, true);
  assert.equal(l.take("a").ok, true);
  const third = l.take("a");
  assert.equal(third.ok, false);
  assert.equal(!third.ok && third.scope, "client");
  assert.equal(l.take("b").ok, true);
  const g = l.take("c");
  assert.equal(!g.ok && g.scope, "global");
  t = 10_000;
  assert.equal(l.take("a").ok, true, "windows reset");
});

test("sealed rating body: four 32-byte ciphertexts, 32-byte key, 16-byte nonce", () => {
  const h = (n: number) => "ab".repeat(n);
  const ok = parseSealedRating(JSON.stringify({ ciphertexts: [h(32), h(32), h(32), h(32)], evaluatorPublicKey: h(32), nonce: h(16) }));
  assert.equal(ok.cts.length, 4);
  assert.equal(ok.cts[0].length, 32);
  assert.throws(() => parseSealedRating(JSON.stringify({ ciphertexts: [h(32)], evaluatorPublicKey: h(32), nonce: h(16) })));
  assert.throws(() => parseSealedRating(JSON.stringify({ ciphertexts: [h(32), h(32), h(32), h(31)], evaluatorPublicKey: h(32), nonce: h(16) })));
  assert.throws(() => parseSealedRating(JSON.stringify({ ciphertexts: [h(32), h(32), h(32), h(32)], evaluatorPublicKey: "zz", nonce: h(16) })));
  // A plaintext rating is refused rather than sealed on the AA's side.
  assert.throws(() => parseSealedRating(JSON.stringify({ slot: 0, delivered: true })));
});

test("catalog prices come from the listed price or an observed quote, never invented", () => {
  const known = knownEndpoints([]);
  assert.ok(known.length > 0);
  assert.ok(known.every((e) => e.priceSource === "listed"));
  assert.ok(!known.some((e) => e.id.startsWith("exa:")), "Exa publishes no per-call price; without an observed quote it is left out");
  const withObserved = knownEndpoints([
    {
      mode: "sweep",
      at: "x",
      week: "w",
      runSpentUsdc: 0,
      weekSpentUsdc: 0,
      summaries: [],
      records: [{ at: "x", target: "exa", path: "/search", method: "POST", quotedUsdc: 0.007, latencyMs: 1, outcome: "paid" }],
    },
  ]);
  const exa = withObserved.find((e) => e.id === "exa:/search");
  assert.equal(exa?.priceMicro, 7000);
  assert.equal(exa?.priceSource, "observed");

  for (const n of [8, 16, 32, 64] as const) {
    const c = catalogOf(n, withObserved);
    assert.equal(c.length, n);
    // Padding never matches a real query.
    assert.deepEqual(
      plainSearch(c, { category: CATEGORY.search, format: 0, maxPriceMicro: 1e9 }).map((i) => c[i].id),
      withObserved.filter((e) => e.category === CATEGORY.search).slice(0, n).map((e) => e.id)
    );
  }
});

test("scoreboard slots by host", () => {
  assert.equal(slotFor("https://osd.x402jp.com/api/alpha/x"), 0);
  assert.equal(slotFor("https://unknown.example/x"), undefined);
  assert.equal(slotFor("not a url"), undefined);
});

test("buyer pays only the exact decided amount to the decided seller", () => {
  const leg = (over: Partial<PaymentRequirements>): PaymentRequirements =>
    ({ scheme: "exact", network: SOLANA_MAINNET, asset: SOLANA_USDC_MINT, payTo: "S", amount: "5000", maxTimeoutSeconds: 60, extra: {}, ...over }) as PaymentRequirements;
  assert.equal(isExpectedLeg(leg({}), 5000n, "S"), true);
  assert.equal(isExpectedLeg(leg({ amount: "5001" }), 5000n, "S"), false);
  assert.equal(isExpectedLeg(leg({ payTo: "T" }), 5000n, "S"), false);
  assert.equal(isExpectedLeg(leg({ network: "eip155:8453" }), 5000n, "S"), false);
  assert.equal(isExpectedLeg(leg({ asset: "other" }), 5000n, "S"), false);
});

test("devnet RPC follows the Helius key, else the public endpoint", () => {
  assert.equal(devnetRpcUrl({ MXE_RPC_URL: "https://x" }), "https://x");
  assert.equal(devnetRpcUrl({ SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=k" }), "https://devnet.helius-rpc.com/?api-key=k");
  assert.equal(devnetRpcUrl({}), "https://api.devnet.solana.com");
});

async function serve(): Promise<{ base: string; close: () => void }> {
  const s = http.createServer((req, res) => void handleMxeSell(req, res));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() };
}

test("seller route: unknown trade is 404; without PayAI keys it refuses with 503, not a 402", async () => {
  const saved = { id: process.env.PAYAI_API_KEY_ID, secret: process.env.PAYAI_API_KEY_SECRET };
  delete process.env.PAYAI_API_KEY_ID;
  delete process.env.PAYAI_API_KEY_SECRET;
  const { base, close } = await serve();
  try {
    assert.equal((await fetch(`${base}/mxe/sell/nope`)).status, 404);
    const t = openTrade({ fn: 1, payTo: "11111111111111111111111111111111", priceMicro: 5000n, product: {} });
    const r = await fetch(`${base}/mxe/sell/${t.id}`);
    assert.equal(r.status, 503);
    assert.match(((await r.json()) as { reason: string }).reason, /PAYAI_API_KEY/);
    assert.throws(() => openTrade({ fn: 1, payTo: "x", priceMicro: 0n, product: {} }));
  } finally {
    close();
    if (saved.id) process.env.PAYAI_API_KEY_ID = saved.id;
    if (saved.secret) process.env.PAYAI_API_KEY_SECRET = saved.secret;
  }
});

test("job with the MXE unreachable records each enabled function as failed, without a computation id", async () => {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mxe-job-"));
  const keep = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("MXE_") || k.startsWith("UPSTASH_")) delete process.env[k];
  process.env.MXE_F1_ENABLED = "true";
  process.env.MXE_F5_ENABLED = "true";
  process.chdir(tmp);
  try {
    const recs = await runMxeJob();
    assert.deepEqual(recs.map((r) => r.fn), [1, 5]);
    for (const r of recs) {
      assert.equal(r.status, "failed");
      assert.match(r.error!, /MXE unavailable: .*MXE_PROGRAM_ID/);
      assert.equal(r.computationOffset, undefined);
      assert.equal(r.result, undefined);
      assert.equal(r.network, "arcium-devnet");
    }
    assert.equal(recs[0].counterparty, "internal");
    assert.equal(recs[1].counterparty, "self");
    const saved = fs.readFileSync(path.join(tmp, "data", "mxe", "mxe-trades.jsonl"), "utf-8").trim().split("\n");
    assert.equal(saved.length, 2);
  } finally {
    process.chdir(cwd);
    process.env = keep;
  }
});
