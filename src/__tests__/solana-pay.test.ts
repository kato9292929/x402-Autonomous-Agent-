/**
 * Solana pay ツールの純ロジック検証(egress 不要):
 *  - PAYMENT-REQUIRED の encode→decode 往復(実 SDK の encoder を使う)
 *  - leg 選択が x402Client と同一規則(v2=solana:* / v1=完全一致、先頭)
 *  - 多重支払いの構造的禁止(2 回目の支払いヘッダで throw)
 * 実 tx(署名・RPC・送金)は egress 必須のため Railway 実行で検証する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import {
  selectSvmLeg,
  legAmount,
  networkMatches,
  makeSinglePaymentFetch,
  type DecodedPaymentRequired,
} from "../lib/solana-pay";
import { withinMicroUsdcCap } from "../x402";

// x402Client の per-call 上限 policy が v1 leg(maxAmountRequired)を全弾していた回帰の防止。
// これがバグって "filtered out by policies for x402 version: 1" で Solana pay が死んでいた。
test("withinMicroUsdcCap: v1 leg(maxAmountRequired のみ)を上限内なら通す(回帰防止)", () => {
  const cap = BigInt(3_000_000); // $3.00
  // v1 Solana leg: amount を持たず maxAmountRequired のみ。旧実装は BigInt(undefined) で throw→false。
  assert.equal(withinMicroUsdcCap({ maxAmountRequired: "10000" }, cap), true); // 0.01 USDC
  assert.equal(withinMicroUsdcCap({ maxAmountRequired: "20000" }, cap), true); // JIN movers 0.02
  // v2 leg: amount を読む
  assert.equal(withinMicroUsdcCap({ amount: "10000" }, cap), true);
  // 上限超過は落とす(セマンティクス維持)
  assert.equal(withinMicroUsdcCap({ maxAmountRequired: "9000000" }, cap), false);
  assert.equal(withinMicroUsdcCap({ amount: "9000000" }, cap), false);
  // どちらの金額フィールドも無ければ落とす
  assert.equal(withinMicroUsdcCap({}, cap), false);
});

// 2026-07-09 実測の accepts(両 leg 併記)を模した固定データ
const V1_LEG = {
  scheme: "exact",
  network: "solana",
  maxAmountRequired: "10000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf",
  maxTimeoutSeconds: 60,
  extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
};
const V2_LEG = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "10000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf",
  maxTimeoutSeconds: 60,
  extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
};

test("networkMatches: solana:* は CAIP-2 に一致し、素の solana には一致しない", () => {
  assert.equal(networkMatches("solana:*", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), true);
  assert.equal(networkMatches("solana:*", "solana"), false);
  assert.equal(networkMatches("solana", "solana"), true);
  assert.equal(networkMatches("solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
});

test("legAmount: v2=amount / v1=maxAmountRequired を吸収", () => {
  assert.equal(legAmount(V2_LEG), "10000");
  assert.equal(legAmount(V1_LEG), "10000");
});

test("selectSvmLeg: x402Version=2 なら v2 leg(solana:* 一致)を掴む", () => {
  const decoded: DecodedPaymentRequired = { x402Version: 2, accepts: [V1_LEG, V2_LEG] };
  const sel = selectSvmLeg(decoded);
  assert.ok(sel);
  assert.equal(sel?.version, 2);
  assert.equal(sel?.matchedPattern, "solana:*");
  assert.equal(sel?.leg.network, V2_LEG.network);
  assert.equal(legAmount(sel!.leg), "10000");
  // 先頭規則: accepts の並びが逆でも network 一致で v2 を選ぶ
  const rev = selectSvmLeg({ x402Version: 2, accepts: [V2_LEG, V1_LEG] });
  assert.equal(rev?.leg.network, V2_LEG.network);
});

test("selectSvmLeg: x402Version=1 なら v1 leg(素の solana)を掴む", () => {
  const decoded: DecodedPaymentRequired = { x402Version: 1, accepts: [V1_LEG, V2_LEG] };
  const sel = selectSvmLeg(decoded);
  assert.ok(sel);
  assert.equal(sel?.version, 1);
  assert.equal(sel?.leg.network, "solana");
  assert.equal(legAmount(sel!.leg), "10000");
});

test("selectSvmLeg: Solana leg が無ければ null(掴まない=停止材料)", () => {
  const decoded: DecodedPaymentRequired = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000" }],
  };
  assert.equal(selectSvmLeg(decoded), null);
});

test("PAYMENT-REQUIRED: 実 SDK encoder で往復し selectSvmLeg が正しく掴む", () => {
  // v2 エンベロープに両 leg を載せて encode→decode(ヘッダ経路の実挙動を再現)
  const pr = { x402Version: 2, accepts: [V1_LEG, V2_LEG], resource: {} };
  const header = encodePaymentRequiredHeader(pr as never);
  assert.equal(typeof header, "string");
  const { decodePaymentRequiredHeader } = require("@x402/core/http");
  const decoded = decodePaymentRequiredHeader(header) as DecodedPaymentRequired;
  assert.equal(decoded.x402Version, 2);
  const sel = selectSvmLeg(decoded);
  assert.equal(sel?.leg.network, V2_LEG.network);
  assert.equal(String(sel?.leg.extra?.feePayer), "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4");
});

test("makeSinglePaymentFetch: 支払いヘッダ付き送信は 1 回まで、2 回目は throw", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT") ?? "(none)");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const guard = makeSinglePaymentFetch(fakeFetch);
  // 無支払いは何度でも OK
  await guard.fetch("https://x/a");
  await guard.fetch("https://x/b");
  assert.equal(guard.paymentAttempts(), 0);
  // 1 回目の支払いは通る
  await guard.fetch("https://x/pay", { headers: { "PAYMENT-SIGNATURE": "sig1" } });
  assert.equal(guard.paymentAttempts(), 1);
  assert.equal(guard.getSentPaymentHeader()?.value, "sig1");
  // 2 回目の支払いは送信前に throw
  await assert.rejects(
    () => guard.fetch("https://x/pay2", { headers: { "X-PAYMENT": "sig2" } }),
    /2 回目の支払い試行をブロック/
  );
  // 2 回目の実 fetch は発火していない(sig2 は calls に無い)
  assert.ok(!calls.includes("sig2"));
});
