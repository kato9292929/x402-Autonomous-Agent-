/**
 * Solana 版 pay→200 検証ツール(汎用)。TEST_URL 差し替えだけで X-alpha / OSD / JIN など
 * 全 Solana エンドポイントの初回 pay→200 検証に使い回す。
 *
 * 署名は Solana native keypair(SOLANA_PRIVATE_KEY)＋ @x402/svm exact のみ。
 * Circle / Base(EIP-3009)経路のコードは一切通らない(このクライアントは SVM しか register しない)。
 *
 * 実行(運用者が Railway で。CC の sandbox は egress 遮断で到達不可):
 *   TEST_URL=https://x-alpha-zeta.vercel.app/claims/active node dist/test-payment-solana.js
 * 必要 env:
 *   TEST_URL           叩く先(ハードコードしない)
 *   SOLANA_PRIVATE_KEY base58 の 64byte keypair(32seed+32pub)。ログ出力しない。
 *
 * 挙動: GET→402→PAYMENT-REQUIRED を base64 decode→leg 選択→fetchWithPayment で 1 回だけ支払い→
 *   200 本文 / PAYMENT-RESPONSE(生+decode) / base58 tx 署名 を全文出力。
 *   失敗時はリトライせず、その時点の status/headers/body と送信済み X-PAYMENT を全文ログして即停止。
 *   支払い試行は 1 プロセス 1 回まで(makeSinglePaymentFetch が構造的に強制)。
 *   feePayer・金額は 402 提示値をそのまま使う(ハードコード禁止)。
 */
import "dotenv/config";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import {
  selectSvmLeg,
  legAmount,
  makeSinglePaymentFetch,
  type DecodedPaymentRequired,
  type SvmLeg,
} from "./lib/solana-pay";

function die(msg: string): never {
  console.error(`\n[SOL-PAY] 停止: ${msg}`);
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
  const solKey = process.env.SOLANA_PRIVATE_KEY;
  if (!solKey) die("SOLANA_PRIVATE_KEY が未設定です(base58 の 64byte keypair)。");

  console.log("=== Solana pay→200 検証ツール ===");
  console.log(`TEST_URL: ${TEST_URL}`);

  // ── SVM のみ register(Base/Circle は register しない=経路を通さない) ──────────
  const keyBytes = base58.decode(solKey);
  const svmSigner = await createKeyPairSignerFromBytes(keyBytes);
  console.log(`[0] SVM signer(公開アドレス): ${svmSigner.address}`); // 秘密鍵は出さない
  const client = new x402Client();
  registerExactSvmScheme(client, { signer: svmSigner });

  // ── 多重支払いを構造的に禁止する fetch を注入 ────────────────────────────────
  const guard = makeSinglePaymentFetch(fetch);
  const fetchWithPay = wrapFetchWithPayment(guard.fetch, client);

  // ── Step A: 無支払い GET → 402 と PAYMENT-REQUIRED を独立に decode・表示 ───────
  console.log("\n[1] 無支払い GET(402 期待)...");
  const first = await fetch(TEST_URL).catch((e) => die(`初回 GET で例外: ${String(e)}`));
  const firstBody = await first.text().catch(() => "");
  console.log(`    status: ${first.status}`);
  console.log(`    body: ${firstBody || "(空)"}`);
  const reqHeader =
    first.headers.get("PAYMENT-REQUIRED") ?? first.headers.get("X-PAYMENT-REQUIRED");
  if (first.status !== 402) die(`402 が返りません(HTTP ${first.status})。`);
  if (!reqHeader) die("PAYMENT-REQUIRED ヘッダがありません(base64 requirements 不在)。");

  let decoded: DecodedPaymentRequired;
  try {
    decoded = decodePaymentRequiredHeader(reqHeader) as unknown as DecodedPaymentRequired;
  } catch (e) {
    return die(`PAYMENT-REQUIRED の decode に失敗: ${String(e)}`);
  }
  console.log("\n[2] decode した 402 requirements:");
  console.log(`    x402Version(トップレベル): ${decoded.x402Version}`);
  console.log(`    accepts(${decoded.accepts?.length ?? 0} leg):`);
  (decoded.accepts ?? []).forEach((leg, i) => console.log(`      [${i}] ${legLine(leg)}`));

  // ── Step B: x402Client と同一規則で掴む leg を明示 ──────────────────────────
  const selected = selectSvmLeg(decoded);
  if (!selected) {
    die(
      `Solana leg が選べません(x402Version=${decoded.x402Version} に登録された network に一致する ` +
        "accepts がない)。Base 混在や version 不一致を疑う。"
    );
  }
  console.log("\n[3] 選択される leg(x402Client 実装と同一規則):");
  console.log(`    index=${selected.index} version=${selected.version} matchedPattern=${selected.matchedPattern}`);
  console.log(`    ${legLine(selected.leg)}`);
  console.log(`    → 送金額(402 提示値)=${legAmount(selected.leg) ?? "?"} atomic, feePayer=${String(selected.leg.extra?.feePayer ?? "?")}`);

  // ── Step C: 支払い 1 回(fetchWithPayment 経路)────────────────────────────────
  console.log("\n[4] 支払い実行(1 回のみ。多重は guard が構造的に禁止)...");
  let res: Response;
  try {
    res = await fetchWithPay(TEST_URL, { method: "GET" });
  } catch (e) {
    const sent = guard.getSentPaymentHeader();
    if (sent) dumpSentPayment(sent);
    return die(`支払い/再取得で例外(リトライしない): ${String(e)}`);
  }

  const bodyText = await res.text().catch(() => "");
  const payRespRaw =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");

  // 送信した X-PAYMENT / PAYMENT-SIGNATURE を decode 表示(秘密鍵は含まれない)
  const sent = guard.getSentPaymentHeader();
  if (sent) dumpSentPayment(sent);

  console.log(`\n[5] 支払い後レスポンス: HTTP ${res.status}`);
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
  console.log(`\n[6] レスポンスボディ全文:\n${bodyText || "(空)"}`);
  console.log(`\n[7] base58 tx 署名: ${base58Sig ?? "(取得できず)"}`);

  if (res.status !== 200) {
    die(`200 ではありません(HTTP ${res.status})。着金確認まで「成功」としない。`);
  }

  console.log("\n=== 出力ここまで。solscan 照合は運用者＋別チャットで行う ===");
  console.log(
    "受け入れ基準: tx が Success / 送金元→payTo へ提示額の着金 / feePayer が 402 提示値 / Solana 決済(Base 混入なし)。" +
      " base58 tx で着金確認できるまで AA 対応完了と言わない。"
  );
}

function dumpSentPayment(sent: { name: string; value: string }): void {
  console.log(`\n[X-PAYMENT] 送信した支払いヘッダ ${sent.name}(生値): ${sent.value}`);
  try {
    const decoded = decodePaymentSignatureHeader(sent.value);
    // payload.transaction は base64 の署名済み wire tx。秘密鍵は含まれない。
    console.log(`[X-PAYMENT] decode: ${JSON.stringify(decoded)}`);
  } catch (e) {
    console.log(`[X-PAYMENT] decode 失敗: ${String(e)}`);
  }
}

main().catch((err) => {
  console.error("[SOL-PAY] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
