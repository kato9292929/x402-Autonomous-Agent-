/**
 * caller.ts の診断まわり。2026-09 の CDP 無料枠ブロック障害で、
 *  - 失敗ボディが 300 字で切れて facilitator の errorMessage が読めなかった
 *  - 設定の chain ラベルが "solana" でも実際は Base で決済していた
 * という2点が原因特定を4日遅らせたので、その2点を固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipBody, networkMatchesChain, ERROR_BODY_MAX_CHARS } from "../caller";

test("clipBody: facilitator の errorMessage まで残る長さがある", () => {
  // 実際に返ってきた形。旧実装の 300 字では errorMessage に届かなかった。
  const body =
    '{"x402Version":2,"error":"facilitator settle error: HTTP 402 Payment Required ' +
    'for https://api.cdp.coinbase.com/platform/v2/x402/settle: ' +
    '{\\"correlationId\\":\\"a3db855dad2e98e4-IAD\\",\\"errorLink\\":' +
    '\\"https://docs.cdp.coinbase.com/api-reference/v2/errors#payment-method-required\\",' +
    '\\"errorMessage\\":\\"A valid payment method is required.\\"}"}';
  assert.ok(body.length > 300, "前提: 旧上限では切れる長さであること");
  const out = clipBody(body);
  assert.equal(out, body, "envelope 全体が残るべき");
  assert.ok(out.includes("errorMessage"));
});

test("clipBody: 上限を超えたら切り詰め、切ったことを明示する", () => {
  const out = clipBody("x".repeat(ERROR_BODY_MAX_CHARS + 500));
  assert.ok(out.length < ERROR_BODY_MAX_CHARS + 100);
  assert.match(out, /文字中/, "切り詰めた事実が残っていない");
});

test("clipBody: 上限以下はそのまま返す", () => {
  assert.equal(clipBody("short"), "short");
});

test("networkMatchesChain: CAIP-2 と v1 エイリアスの両方を同じ chain とみなす", () => {
  assert.ok(networkMatchesChain("base", "base"));
  assert.ok(networkMatchesChain("eip155:8453", "base"));
  assert.ok(networkMatchesChain("solana", "solana"));
  assert.ok(networkMatchesChain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana"));
});

test("networkMatchesChain: 障害時の食い違いを不一致として検出する", () => {
  // ログは [CALLER:solana] と出ていたが、売り手の dual-leg は Base が accepts[0]
  // で、買い手の既定セレクタがそれを選んでいた。この食い違いを黙らせない。
  assert.equal(networkMatchesChain("eip155:8453", "solana"), false);
  assert.equal(networkMatchesChain("base", "solana"), false);
  assert.equal(networkMatchesChain("solana:5eykt4Us", "base"), false);
});

test("networkMatchesChain: 未知の chain は一致としない", () => {
  assert.equal(networkMatchesChain("eip155:8453", "unknown"), false);
});
