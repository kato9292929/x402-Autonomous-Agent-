/**
 * gas 予算強制の純ロジック検証(egress 不要)。
 *  - 1tx 上限 / 通算上限の判定
 *  - USD 換算(gasUsed × gasPrice)
 *  - レート未指定の mainnet は「推測で 0 にせず」失敗すること
 *  - validationResponse の response 範囲(0-100)チェック
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gasCostUsd,
  checkBudget,
  assertWithinBudget,
  resolveUsdPerNative,
  GasBudgetError,
} from "../erc8004/gas-budget";
import { assertValidResponse } from "../erc8004/arc-validation";
import { renderRunRecord } from "../scripts/erc8004-run-report";
import type { RegistryRunEntry } from "../erc8004/registry-run-log";

test("gasCostUsd: gasUsed × gasPrice × レート を USD に換算する", () => {
  // 100,000 gas × 1 gwei = 1e14 wei = 0.0001 native。レート $3000 → $0.30
  const usd = gasCostUsd(100_000n, 1_000_000_000n, 3000);
  assert.ok(Math.abs(usd - 0.3) < 1e-9, `expected ~0.30, got ${usd}`);
  // レート 0(テストネット)なら 0
  assert.equal(gasCostUsd(100_000n, 1_000_000_000n, 0), 0);
});

test("checkBudget: 1tx 上限を超えたら不許可", () => {
  const c = checkBudget(0.25, 0, 0.1, 1.0);
  assert.equal(c.allowed, false);
  assert.match(c.reason ?? "", /1tx 上限超過/);
});

test("checkBudget: 通算上限に到達済みなら不許可", () => {
  const c = checkBudget(0.01, 1.0, 0.1, 1.0);
  assert.equal(c.allowed, false);
  assert.match(c.reason ?? "", /通算上限に到達済み/);
});

test("checkBudget: 通算を超える見込みでも不許可(境界を跨がせない)", () => {
  const c = checkBudget(0.05, 0.98, 0.1, 1.0);
  assert.equal(c.allowed, false);
  assert.match(c.reason ?? "", /通算上限超過の見込み/);
  assert.ok(Math.abs(c.remainingUsd - 0.02) < 1e-9);
});

test("checkBudget: 両方の上限内なら許可", () => {
  const c = checkBudget(0.02, 0.5, 0.1, 1.0);
  assert.equal(c.allowed, true);
  assert.equal(c.reason, undefined);
});

test("assertWithinBudget: 不許可なら GasBudgetError で大きく失敗する(握りつぶさない)", () => {
  assert.throws(() => assertWithinBudget(checkBudget(0.5, 0, 0.1, 1.0)), GasBudgetError);
  assert.doesNotThrow(() => assertWithinBudget(checkBudget(0.01, 0, 0.1, 1.0)));
});

test("resolveUsdPerNative: ARC-TESTNET は faucet トークンなので 0", () => {
  const saved = process.env.ERC8004_GAS_USD_PER_NATIVE;
  delete process.env.ERC8004_GAS_USD_PER_NATIVE;
  try {
    assert.equal(resolveUsdPerNative("ARC-TESTNET"), 0);
  } finally {
    if (saved !== undefined) process.env.ERC8004_GAS_USD_PER_NATIVE = saved;
  }
});

test("resolveUsdPerNative: mainnet でレート未指定なら推測せず失敗する", () => {
  const saved = process.env.ERC8004_GAS_USD_PER_NATIVE;
  delete process.env.ERC8004_GAS_USD_PER_NATIVE;
  try {
    assert.throws(() => resolveUsdPerNative("BASE-MAINNET"), GasBudgetError);
  } finally {
    if (saved !== undefined) process.env.ERC8004_GAS_USD_PER_NATIVE = saved;
  }
});

test("assertValidResponse: 仕様どおり 0-100 の整数のみ通す(真偽値ではない)", () => {
  assert.doesNotThrow(() => assertValidResponse(0));
  assert.doesNotThrow(() => assertValidResponse(100));
  assert.throws(() => assertValidResponse(101)); // require(response <= 100)
  assert.throws(() => assertValidResponse(-1));
  assert.throws(() => assertValidResponse(1.5));
});

test("renderRunRecord: 記録が空なら『未実行』と明示する(埋まっているように見せない)", () => {
  const out = renderRunRecord([], 0);
  assert.match(out, /未実行/);
  assert.match(out, /通算 gas: \*\*\$0\.000000\*\*/);
});

test("renderRunRecord: 実行記録から表が埋まり、失敗も理由付きで残る", () => {
  const entries: RegistryRunEntry[] = [
    {
      at: "2026-08-18T09:12:03.000Z",
      chain: "ARC-TESTNET",
      registry: "ReputationRegistry",
      registry_address: "0x8004B663",
      fn: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      subject: "agentId=845265",
      result: "success",
      tx_hash: "0xabc123def4567890",
      gas_cost_usd: 0,
    },
    {
      at: "2026-08-18T09:20:00.000Z",
      chain: "ARC-TESTNET",
      registry: "ValidationRegistry",
      registry_address: "0x8004Cb1B",
      fn: "validationResponse(bytes32,uint8,string,bytes32,string)",
      subject: "requestHash=0xdead response=100",
      result: "failed",
      error: "not validator",
    },
  ];
  const out = renderRunRecord(entries, 0.0004);
  assert.doesNotMatch(out, /未実行/);
  assert.match(out, /giveFeedback/);
  assert.match(out, /`0xabc123de…`/); // tx が載る(先頭10文字で切り詰め)
  assert.match(out, /\*\*failed\*\*/); // 失敗を success に丸めない
  assert.match(out, /not validator/); // 失敗理由をそのまま残す
  assert.match(out, /success 1 件 \/ それ以外 1 件/);
});
