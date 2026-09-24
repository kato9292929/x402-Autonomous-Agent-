/**
 * Arc (eip155:5042) の支払いレグ。
 *
 * Arc 対応で足したのは署名者の登録だけで、Arc 専用の支払いコードは書いていない。
 * それが成立するのは次の2点による。ライブラリ更新で崩れたら気付けるよう固定する。
 *
 *  1. v2 の chainId は CAIP-2 文字列から解析される（ローカルの表を引かない）。
 *     @x402/evm の DEFAULT_STABLECOINS に Arc は無いが、それは売り手側が要件を
 *     組み立てるための表であって、買い手の署名には要らない。
 *  2. asset アドレスと EIP-712 の name / version は売り手の 402 から来る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARC_NETWORK, ARC_USDC_ERC20, TESTNET_NETWORK } from "../payment-guard";
import { withinMicroUsdcCap } from "../x402";

test("ARC_NETWORK は Arc mainnet の CAIP-2", () => {
  assert.equal(ARC_NETWORK, "eip155:5042");
});

test("chainId は CAIP-2 から解析できる形になっている", () => {
  // 買い手が Arc を扱えるのはこの解析が効くため。表を引く形なら Arc は未対応になる。
  const [namespace, reference] = ARC_NETWORK.split(":");
  assert.equal(namespace, "eip155");
  assert.equal(Number.parseInt(reference, 10), 5042);
  assert.ok(!Number.isNaN(Number.parseInt(reference, 10)));
});

test("Arc の USDC は ERC-20 interface のアドレス（6桁）", () => {
  // Arc docs: mainnet / testnet 同一。ネイティブ残高は18桁なので混ぜない。
  assert.equal(ARC_USDC_ERC20, "0x3600000000000000000000000000000000000000");
  assert.match(ARC_USDC_ERC20, /^0x[0-9a-fA-F]{40}$/);
});

test("Arc は Base・Base Sepolia と別のネットワークとして扱われる", () => {
  assert.notEqual(ARC_NETWORK, TESTNET_NETWORK);
  assert.notEqual(ARC_NETWORK, "eip155:8453");
});

test("per-call 上限は Arc にもそのまま効く（チェーン非依存）", () => {
  // registerPolicy はネットワークを問わず全要件に適用される。Arc を足しても
  // 上限が素通りになることはない、を固定する。
  const cap = BigInt(3_000_000); // $3.00
  assert.equal(withinMicroUsdcCap({ amount: "10000" }, cap), true); // $0.01
  assert.equal(withinMicroUsdcCap({ amount: "3000001" }, cap), false); // $3.000001
  // Arc の 402 が v1 形式で来ても金額が読めること
  assert.equal(withinMicroUsdcCap({ maxAmountRequired: "10000" }, cap), true);
});

test("金額が読めない要件は Arc でも弾く", () => {
  assert.equal(withinMicroUsdcCap({}, BigInt(3_000_000)), false);
});

// ── Arc を一級のチェーンとして扱う ─────────────────────────────────────────
// 支払いレグだけ足して監視・ラベルを足さないと、Base で起きたのと同じ
// 「静かに枯れる」経路がもう1本増える。
import { networkMatchesChain } from "../caller";
import { ARC_WARN_USDC, evaluateBalances, type LegBalance } from "../balance-guard";

test("networkMatchesChain: Arc の決済を arc ラベルと一致させる", () => {
  assert.ok(networkMatchesChain("eip155:5042", "arc"));
  assert.ok(networkMatchesChain("arc", "arc"));
});

test("networkMatchesChain: Arc と Base を取り違えない", () => {
  // どちらも eip155 なので、接頭辞だけの判定だと混ざる。
  assert.equal(networkMatchesChain("eip155:8453", "arc"), false);
  assert.equal(networkMatchesChain("eip155:5042", "base"), false);
});

test("残高ガードが arc leg を評価できる", () => {
  const legs: LegBalance[] = [
    { leg: "arc", address: "0xae7c34b72d0f49605ee2448c5f0d0ecfb4fcfec8", usdc: 0.5, threshold: ARC_WARN_USDC },
  ];
  const [w] = evaluateBalances(legs);
  assert.match(w, /LOW BALANCE/);
  assert.match(w, /arc/);
});

test("Arc は閾値以上なら警告しない", () => {
  assert.deepEqual(
    evaluateBalances([{ leg: "arc", usdc: ARC_WARN_USDC, threshold: ARC_WARN_USDC }]),
    []
  );
});
