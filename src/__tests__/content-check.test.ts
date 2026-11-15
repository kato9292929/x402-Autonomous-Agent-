/**
 * The bodies below are the ones the 11/12 run paid for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBody, contentHash, dailyChange, backfillContent, substantiveLeaves } from "../content-check";

test("Smart Money Screener with no tokens is empty, with Nansen's warning as the reason", () => {
  const r = checkBody("smart-money-screener", {
    timestamp: "2026-11-12T21:00:22.874Z",
    tokens: [],
    total_scanned: 0,
    warnings: ["solana: Nansen does not appear to support smart-money flows for this chain at this time."],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /tokens 0件\(total_scanned 0\): solana: Nansen/);
  assert.equal(checkBody("smart-money-screener", { tokens: [{ symbol: "X", netflow: 1 }], total_scanned: 40 }).ok, true);
});

test("Divergence Analyzer with no results is empty", () => {
  assert.deepEqual(checkBody("divergence-analyzer", { scannedAt: "x", chain: "base", results: [] }), { ok: false, reason: "results 0件" });
});

test("Whale Alert with a placeholder tx hash is not content", () => {
  const r = checkBody("onchain-feed-whale", { alert_count: 2, transfers: [{ tx_hash: "0xabc123", usd: 1e6 }] });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /0xabc123/);
  const real = "0x" + "a".repeat(64);
  assert.equal(checkBody("onchain-feed-whale", { transfers: [{ tx_hash: real, usd: 1e6 }] }).ok, true);
});

test("a body that only repeats the input is empty", () => {
  const sent = { walletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "base" };
  const echo = { ...sent, riskTolerance: "MEDIUM", analyzedAt: "2026-11-12T21:00:10Z", holdings: [], totalValueUsd: 0 };
  assert.deepEqual(checkBody("portfolio-intelligence", echo, sent), { ok: false, reason: "送った入力の繰り返しだけで中身が無い" });
  assert.equal(checkBody("portfolio-intelligence", { ...echo, holdings: [{ token: "ETH", usd: 1200 }] }, sent).ok, true);
});

test("generic bodies: empty object fails, real data passes", () => {
  assert.equal(checkBody("any", {}).ok, false);
  assert.equal(checkBody("any", { date: "2026-11-12", source: "live" }).ok, false);
  assert.equal(checkBody("odo-funding-nowcast", { date: "2026-11-12", source: "live", gauges: [{ basket: "majors", count: 4 }] }).ok, true);
  assert.equal(substantiveLeaves({ a: [], b: 0, c: "" }), 0);
});

test("a daily feed identical to an earlier day's (timestamps aside) is flagged", () => {
  const day = (d: string) => ({ date: d, region: "APAC", summary_ja: "本日のAPACオンチェーンサマリー：APAC取引所ネットフロー$15M。" });
  const h4 = contentHash(day("2026-11-04"));
  assert.equal(h4, contentHash(day("2026-11-12")), "the date alone does not change the hash");
  const first = dailyChange(undefined, h4, "2026-11-04");
  assert.equal(first.unchanged, false);
  assert.equal(dailyChange(first.next, h4, "2026-11-04").unchanged, false, "a same-day rerun is not a repeat");
  const later = dailyChange(first.next, h4, "2026-11-05");
  assert.equal(later.unchanged, true);
  assert.equal(later.next.since, "2026-11-04");
  assert.equal(dailyChange(later.next, contentHash({ ...day("x"), summary_ja: "new" }), "2026-11-06").unchanged, false);
});

test("old runs are judged from the body they kept, not from a cut-off peek", () => {
  const ids = (u: string) => (u.includes("divergence") ? "divergence-analyzer" : undefined);
  const whole = backfillContent(
    { endpoint: "https://x402nansenpolymarket.vercel.app/api/divergence/scan", status: "success", responsePeek: '{"scannedAt":"x","chain":"base","results":[]}' },
    ids
  );
  assert.deepEqual(whole.content, { ok: false, reason: "results 0件", inferred: true });
  const cut = backfillContent({ endpoint: "https://x/a", status: "success", responsePeek: '{"walletAddress":"0xd8' }, ids);
  assert.equal(cut.content, undefined);
});
