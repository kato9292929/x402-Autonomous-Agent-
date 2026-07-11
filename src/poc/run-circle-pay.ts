/**
 * Circle-DCW-Solana 署名で「実際に払って 200 を取る」確証スクリプト(ゲート A の最終確認)。
 *
 * run-circle-poc.js は payload が組めるところまで(=Circle が署名を返しマージが throw しない)を
 * 見た。だが「payload が組めた」≠「その署名が有効で on-chain settle する」。最終確証は実払い→200→
 * solscan 着金(payer=Circle ウォレット)。本スクリプトはそこまで行く。
 *
 * ★実際に 0.01 USDC が動く。多重支払いは makeSinglePaymentFetch で 1 プロセス 1 回に構造的制限。
 *
 * 実行(Railway・egress要・本番 LIVE Circle 認証):
 *   TEST_URL=https://x-alpha-zeta.vercel.app/claims/active node dist/poc/run-circle-pay.js
 * 必要 env: run-circle-poc.js と同じ(CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET /
 *   CIRCLE_SOLANA_WALLET_ID / CIRCLE_SOLANA_WALLET_ADDRESS / TEST_URL / 任意 SOLANA_RPC_URL)。
 * 秘密はログに出さない(base58 tx 署名は出す)。
 */
import "dotenv/config";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { base58 } from "@scure/base";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { circleSolanaSigner, type CircleSignTransactionClient } from "./circle-solana-signer";
import { makeSinglePaymentFetch } from "../lib/solana-pay";

function die(msg: string): never {
  console.error(`\n[CIRCLE-PAY] 停止: ${msg}`);
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

  console.log("=== Circle-DCW-Solana 実払い確証(ゲート A 最終) ===");
  console.log(`TEST_URL: ${TEST_URL}`);
  console.log(`payer(Circle Solana wallet): ${walletAddress}`);
  console.log("※ 実際に 0.01 USDC が動く。支払いは 1 回のみ(guard)。");

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
  const signer = circleSolanaSigner(client, walletId, walletAddress, (s) => base58.decode(s));

  // Circle 署名器を SVM scheme として登録(Base/Circle-EVM は積まない=Solana 経路のみ)
  const x402 = new x402Client();
  registerExactSvmScheme(x402, { signer });

  // 多重支払いを構造的に禁止
  const guard = makeSinglePaymentFetch(fetch);
  const fetchWithPay = wrapFetchWithPayment(guard.fetch, x402);

  console.log("\n[1] fetchWithPayment(Circle 署名経路)で 1 回支払い...");
  let res: Response;
  try {
    res = await fetchWithPay(TEST_URL, { method: "GET" });
  } catch (e) {
    return die(`支払いで例外(リトライしない): ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.text().catch(() => "");
  const payResp = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");

  console.log(`\n[2] HTTP ${res.status}`);
  console.log(`    PAYMENT-RESPONSE(生値): ${payResp ?? "(なし)"}`);
  let sig: string | null = null;
  let payer: string | null = null;
  if (payResp) {
    try {
      const s = decodePaymentResponseHeader(payResp) as {
        success?: boolean;
        transaction?: string;
        network?: string;
        payer?: string;
        errorReason?: string;
      };
      sig = s.transaction ?? null;
      payer = s.payer ?? null;
      console.log(`    PAYMENT-RESPONSE(decode): ${JSON.stringify(s)}`);
    } catch (e) {
      console.log(`    decode 失敗: ${String(e)}`);
    }
  }
  console.log(`\n[3] レスポンスボディ(先頭400):\n${body.slice(0, 400)}`);
  console.log(`\n[4] base58 tx 署名: ${sig ?? "(取得できず)"}`);
  console.log(`    payer(期待=${walletAddress}): ${payer ?? "(なし)"}`);

  if (res.status !== 200) {
    die(`200 ではない(HTTP ${res.status})。着金確認まで成立としない。verify 落ちなら PAYMENT-RESPONSE の errorReason を見る。`);
  }
  if (payer && payer !== walletAddress) {
    console.log(`\n[!] payer が Circle ウォレットと不一致(${payer})。生keypair経路が混じっていないか確認。`);
  }
  console.log(
    "\n=== 200 取得。solscan で tx を Success 確認・payer=Circle ウォレット・4s8X… へ 0.01 USDC 着金を確認するまで\n" +
      "    「Circle-DCW-Solana 決済 成立」と最終確定しない。生値(署名/payer/status)を持ち帰る。 ==="
  );
}

main().catch((err) => {
  console.error("[CIRCLE-PAY] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
