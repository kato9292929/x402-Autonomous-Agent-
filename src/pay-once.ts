/**
 * 本番 AA の決済経路(initX402Fetch = policy を積んだ本番クライアント)で TEST_URL を
 * 1 回だけ叩く実測用コマンド。日次は X-alpha を叩かないため、本番経路での pay→200 の
 * 実証にはこの経路が要る。
 *
 * 重要: test-payment-solana.js は registerPolicy を積まない最小クライアントなので本番の
 * 証拠にならない。こちらは fetchWithPayment(= initX402Fetch のクライアント)を使うので、
 * 上限 policy・Base(Circle DCW)/Solana(svm) の両 register を含む「本番そのまま」の経路。
 *
 * 実行(Railway コンソール。本番 env がある環境で):
 *   TEST_URL=https://x-alpha-zeta.vercel.app/claims/active node dist/pay-once.js
 * 必要 env(本番 AA と同じ。Railway に設定済みの想定):
 *   TEST_URL           叩く先(ハードコードしない)
 *   SIGNER_BACKEND     circle(本番) — Base 署名器の初期化に必要
 *   CIRCLE_*           Circle DCW 認証(Base 署名器の初期化に必要)
 *   SOLANA_PRIVATE_KEY Solana 署名(これが無いと Solana leg は register されない)
 *
 * 挙動: initX402Fetch→無支払い GET で 402 を decode 表示(選択 leg 明示)→fetchWithPayment で
 *   1 回支払い→200 本文 / PAYMENT-RESPONSE(生+decode) / base58 tx を全文出力。
 *   200 以外・例外はその場の情報を全文ログして即停止(リトライしない)。
 */
import "dotenv/config";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { initX402Fetch, fetchWithPayment } from "./x402";
import {
  selectSvmLeg,
  legAmount,
  type DecodedPaymentRequired,
  type SvmLeg,
} from "./lib/solana-pay";

function die(msg: string): never {
  console.error(`\n[PAY-ONCE] 停止: ${msg}`);
  process.exit(1);
}

function legLine(leg: SvmLeg): string {
  return (
    `scheme=${leg.scheme ?? "?"} network=${leg.network ?? "?"} ` +
    `amount(v2)=${leg.amount ?? "-"} maxAmountRequired(v1)=${leg.maxAmountRequired ?? "-"} ` +
    `asset=${leg.asset ?? "?"} payTo=${leg.payTo ?? "?"} feePayer=${String(leg.extra?.feePayer ?? "?")}`
  );
}

async function main(): Promise<void> {
  const TEST_URL = process.env.TEST_URL;
  if (!TEST_URL) die("TEST_URL が未設定です(叩く先を TEST_URL で渡す)。");

  console.log("=== pay-once: 本番 AA 経路(policy 込み)で TEST_URL を 1 回叩く ===");
  console.log(`TEST_URL: ${TEST_URL}`);

  // 本番クライアントを初期化(Base Circle DCW + Solana svm + 上限 policy)。
  // ログに backend と署名アドレスが出る(秘密鍵は出ない)。
  await initX402Fetch();

  // ── 無支払い GET → 402 を独立に decode 表示(選択 leg 明示) ─────────────────
  console.log("\n[1] 無支払い GET(402 期待)...");
  const first = await fetch(TEST_URL).catch((e) => die(`初回 GET で例外: ${String(e)}`));
  const firstBody = await first.text().catch(() => "");
  console.log(`    status: ${first.status}`);
  console.log(`    body: ${firstBody || "(空)"}`);
  const reqHeader =
    first.headers.get("PAYMENT-REQUIRED") ?? first.headers.get("X-PAYMENT-REQUIRED");
  if (first.status === 402 && reqHeader) {
    try {
      const decoded = decodePaymentRequiredHeader(reqHeader) as unknown as DecodedPaymentRequired;
      console.log(`\n[2] decode した 402: x402Version=${decoded.x402Version}, accepts=${decoded.accepts?.length ?? 0} leg`);
      (decoded.accepts ?? []).forEach((leg, i) => console.log(`      [${i}] ${legLine(leg)}`));
      const sel = selectSvmLeg(decoded);
      if (sel) {
        console.log(
          `    → 本番クライアントが掴む Solana leg: index=${sel.index} version=${sel.version} ` +
            `pattern=${sel.matchedPattern} 金額=${legAmount(sel.leg) ?? "?"} feePayer=${String(sel.leg.extra?.feePayer ?? "?")}`
        );
      } else {
        console.log("    → Solana leg 該当なし(Base leg のみか version 不一致)。");
      }
    } catch (e) {
      console.log(`[2] PAYMENT-REQUIRED decode 失敗: ${String(e)}`);
    }
  } else {
    console.log("    (PAYMENT-REQUIRED ヘッダ無し or 402 以外。fetchWithPayment 側の挙動を見る)");
  }

  // ── 本番経路で 1 回支払い ────────────────────────────────────────────────────
  console.log("\n[3] fetchWithPayment で支払い(本番 policy 経路)...");
  let res: Response;
  try {
    res = await fetchWithPayment(TEST_URL, { method: "GET" });
  } catch (e) {
    return die(`支払い/再取得で例外(リトライしない): ${String(e)}`);
  }
  const bodyText = await res.text().catch(() => "");
  const payRespRaw =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");

  console.log(`\n[4] 支払い後: HTTP ${res.status}`);
  console.log(`    PAYMENT-RESPONSE(生値): ${payRespRaw ?? "(なし)"}`);
  let base58Sig: string | null = null;
  if (payRespRaw) {
    try {
      const settle = decodePaymentResponseHeader(payRespRaw) as {
        success?: boolean;
        transaction?: string;
        network?: string;
        payer?: string;
        errorReason?: string;
      };
      base58Sig = settle.transaction ?? null;
      console.log(`    PAYMENT-RESPONSE(decode): ${JSON.stringify(settle)}`);
    } catch (e) {
      console.log(`    PAYMENT-RESPONSE decode 失敗: ${String(e)}`);
    }
  }
  console.log(`\n[5] レスポンスボディ全文:\n${bodyText || "(空)"}`);
  console.log(`\n[6] base58 tx 署名: ${base58Sig ?? "(取得できず)"}`);

  if (res.status !== 200) {
    die(`200 ではありません(HTTP ${res.status})。着金確認まで「成功」としない。`);
  }
  console.log(
    "\n=== 200 取得。solscan で 6JKVug…→4s8X… の着金(base58 tx, Success)を確認するまで pay→200 完了としない ==="
  );
}

main().catch((err) => {
  console.error("[PAY-ONCE] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
