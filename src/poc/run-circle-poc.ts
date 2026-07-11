/**
 * Circle-DCW-Solana 署名 PoC(AA v2 ゲート A)の実行スクリプト。編集不要で走る。
 *
 * README §A の A-2(mock→実Circle)＋A-3(fake tx→実402 v2 leg で createPaymentPayload)を
 * 1本にした実コード。X-PAYMENT payload が組めれば残ゲート (ii)encoding / Q3(feePayer≠wallet) は YES。
 * 実払いはしない(可否は payload 構築で出る)。
 *
 * 実行(Railway・egress要。本番 LIVE Circle 認証がある環境):
 *   TEST_URL=https://x-alpha-zeta.vercel.app/claims/active node dist/poc/run-circle-poc.js
 * 必要 env:
 *   CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET      既存 LIVE(EVM DCW と同じ。_TEST は使わない)
 *   CIRCLE_SOLANA_WALLET_ID                    PoC の Circle Solana ウォレット walletId
 *   CIRCLE_SOLANA_WALLET_ADDRESS               その Solana address
 *   TEST_URL                                   叩く先(既定 X-alpha /claims/active)
 *   SOLANA_RPC_URL                             任意。svm の mint/blockhash 取得に使う RPC 上書き
 *
 * 秘密鍵・APIキー・entity secret はログ出力しない。
 */
import "dotenv/config";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm";
import { base58 } from "@scure/base";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { circleSolanaSigner, type CircleSignTransactionClient } from "./circle-solana-signer";
import { selectSvmLeg, legAmount, type DecodedPaymentRequired } from "../lib/solana-pay";

function die(msg: string): never {
  console.error(`\n[CIRCLE-POC] 停止: ${msg}`);
  process.exit(1);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) die(`${name} が未設定です。`);
  return v;
}

async function main(): Promise<void> {
  const TEST_URL = process.env.TEST_URL ?? "https://x-alpha-zeta.vercel.app/claims/active";
  const apiKey = need("CIRCLE_API_KEY");
  const entitySecret = need("CIRCLE_ENTITY_SECRET");
  const walletId = need("CIRCLE_SOLANA_WALLET_ID");
  const walletAddress = need("CIRCLE_SOLANA_WALLET_ADDRESS");

  console.log("=== Circle-DCW-Solana 署名 PoC(ゲート A) ===");
  console.log(`TEST_URL: ${TEST_URL}`);
  console.log(`Circle Solana wallet: ${walletAddress} (id ...${walletId.slice(-6)})`); // 秘密は出さない

  // A-2: 実 Circle クライアント → CircleSignTransactionClient(最小契約)にアダプト
  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const client: CircleSignTransactionClient = {
    async signTransaction(input) {
      const r = await circle.signTransaction({
        walletId: input.walletId,
        rawTransaction: input.rawTransaction,
      });
      return { data: { signature: r.data?.signature } };
    },
  };

  // Circle 署名を @solana/kit の TransactionPartialSigner に載せる(base58 注入つき)
  const signer = circleSolanaSigner(client, walletId, walletAddress, (s) => base58.decode(s));

  // A-3(1): 無支払い GET → 402 → v2 Solana leg を選ぶ
  console.log("\n[1] 無支払い GET(402 期待)...");
  const res = await fetch(TEST_URL).catch((e) => die(`GET で例外: ${String(e)}`));
  await res.text().catch(() => "");
  console.log(`    status: ${res.status}`);
  if (res.status !== 402) die(`402 が返りません(HTTP ${res.status})。`);
  const reqHeader = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("X-PAYMENT-REQUIRED");
  if (!reqHeader) die("PAYMENT-REQUIRED ヘッダがありません。");

  const decoded = decodePaymentRequiredHeader(reqHeader) as unknown as DecodedPaymentRequired;
  const selected = selectSvmLeg(decoded);
  if (!selected) die(`Solana leg が選べません(x402Version=${decoded.x402Version})。`);
  console.log(
    `[2] 選択 leg: version=${selected.version} network=${selected.leg.network} ` +
      `amount=${legAmount(selected.leg)} feePayer=${String(selected.leg.extra?.feePayer ?? "?")}`
  );

  // A-3(3): payload 構築を @x402/svm に委譲(内部で partiallySign→Circle 署名→tx マージ)
  console.log("\n[3] ExactSvmScheme.createPaymentPayload に委譲(内部で Circle に署名要求)...");
  const scheme = new ExactSvmScheme(
    signer,
    process.env.SOLANA_RPC_URL ? { rpcUrl: process.env.SOLANA_RPC_URL } : undefined
  );
  let payload: unknown;
  try {
    payload = await scheme.createPaymentPayload(2, selected.leg as unknown as PaymentRequirements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n[X] createPaymentPayload が throw: ${msg}`);
    console.error(
      "\n判定材料:\n" +
        " - `wallet must be fee payer`/`fee payer` 系 → Q3 NO(Circle が feePayer≠wallet を署名拒否)\n" +
        " - `not 64-byte base64`/署名 decode 系 → (ii) encoding。base58 注入は済んでいるので、\n" +
        "   それでも出るなら Circle の signature 実 encoding を確認しアダプタを合わせる\n" +
        " - RPC/mint/blockhash 系 → SOLANA_RPC_URL を設定して再試行\n" +
        " - それ以外 → エラー全文をそのまま持ち帰る"
    );
    process.exit(1);
  }

  // 成立: payload(署名済み tx を含む)が組めた = (ii)/Q3 YES
  const p = payload as { x402Version?: number; payload?: { transaction?: string } };
  const tx = p.payload?.transaction ?? "";
  console.log("\n[4] ✓ X-PAYMENT payload 構築 成功 → (ii)encoding / Q3(feePayer≠wallet) は YES");
  console.log(`    x402Version: ${p.x402Version}`);
  console.log(`    payload.transaction(先頭60): ${tx.slice(0, 60)}${tx.length > 60 ? "…" : ""}`);
  console.log(
    "\n=== 判定: Circle-DCW-Solana 署名は成立。次は pay-once 相当で実払い→200→solscan 着金で確証 ==="
  );
  console.log("結果(payload 構築 yes・エラー全文/実払い status)を aa-v2-redesign §3.2/§4 に書き戻す。");
}

main().catch((err) => {
  console.error("[CIRCLE-POC] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
