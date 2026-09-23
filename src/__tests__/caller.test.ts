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

// ── 402 の失敗段の判別 ──────────────────────────────────────────────────────
// `HTTP 402: {}` が「支払い未受理の再チャレンジ」なのか「受理後に 200 に
// 至らなかった」のかを、ヘッダだけで分ける。この区別が付かず調査が止まった。
import { describeX402Failure } from "../caller";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const res402 = (headers: Record<string, string>) =>
  new Response("{}", { status: 402, headers });

test("402 + PAYMENT-REQUIRED → 再チャレンジ（支払い未受理）と提示ネットワーク", () => {
  const out = describeX402Failure(
    res402({
      "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        accepts: [{ network: "solana:5eykt4Us", scheme: "exact" }],
      }),
    })
  );
  assert.match(out, /再チャレンジ\(支払い未受理\)/);
  assert.match(out, /v2 offered=solana:5eykt4Us\/exact/);
});

test("402 + 複数 leg → 提示された全ネットワークを並べる", () => {
  const out = describeX402Failure(
    res402({
      "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        accepts: [{ network: "eip155:8453" }, { network: "solana:5eykt4Us" }],
      }),
    })
  );
  assert.match(out, /offered=eip155:8453\/\?,solana:5eykt4Us\/\?/);
});

test("402 かつ PAYMENT-REQUIRED 無し → 受理後に 200 に至らなかった側と分かる", () => {
  assert.match(describeX402Failure(res402({})), /再チャレンジなし/);
});

test("402 + PAYMENT-RESPONSE → settle の中身を出す", () => {
  const out = describeX402Failure(
    res402({ "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds" }) })
  );
  assert.match(out, /settle=/);
  assert.match(out, /insufficient_funds/);
});

test("復号できないヘッダでも落ちない", () => {
  const out = describeX402Failure(res402({ "PAYMENT-REQUIRED": "!!!not-base64!!!" }));
  assert.match(out, /再チャレンジ/);
});

test("402 以外では何も足さない", () => {
  assert.equal(describeX402Failure(new Response("boom", { status: 500 })), "");
});
