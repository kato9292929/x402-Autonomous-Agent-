/**
 * One-shot: Arc(Circle TEST 環境)の entity secret を生成 → Circle へ登録 → 控える値を出力。
 *
 * entity secret は環境(TEST/LIVE)ごとに1回だけ登録が必要。LIVE は登録済みだが TEST が未登録
 * だと arc-create-wallets が HTTP 403 / code 156016 になる。これを解消するために1回だけ走らせる。
 *
 * 実行(Railway で1回):
 *   node dist/scripts/arc-setup-entity-secret.js
 * 必要 env (TEST キーのみ。LIVE 認証は参照しない):
 *   CIRCLE_API_KEY_TEST
 *
 * 出力(ログのみ。ファイルには書き出さない・コミットしない):
 *   - CIRCLE_ENTITY_SECRET_TEST に設定する 64桁 hex
 *   - recovery file の内容(失うと復旧不可。安全に保管する)
 *
 * 型は @circle-fin/developer-controlled-wallets の型定義で確認済み:
 *   registerEntitySecretCiphertext({ apiKey, entitySecret }) → response.data?.recoveryFile
 *   generateEntitySecret() は戻り値 void(console 表示のみ)のため使わず、entity secret は
 *   32byte hex(既存 CIRCLE_ENTITY_SECRET と同形式)を自前生成する。
 */
import "dotenv/config";
import * as crypto from "node:crypto";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";
import { getRequiredArcTestApiKey } from "../circle/arc-test-client";

async function main(): Promise<void> {
  const apiKey = getRequiredArcTestApiKey(); // CIRCLE_API_KEY_TEST。LIVE は参照しない

  // Circle の entity secret は 32byte hex(64桁)。generateEntitySecret() は void なので自前生成。
  const entitySecret = crypto.randomBytes(32).toString("hex");

  console.log("[ARC-SETUP] TEST 環境に entity secret を登録します...");
  const response = await registerEntitySecretCiphertext({ apiKey, entitySecret });
  const recoveryFile = response.data?.recoveryFile ?? "";

  console.log("\n============================================================");
  console.log("[ARC-SETUP] 登録完了。以下を安全に控えてください(この画面のみ)。");
  console.log("============================================================");
  console.log("\n1) CIRCLE_ENTITY_SECRET_TEST に設定する値(64桁 hex):");
  console.log(entitySecret);
  console.log("\n2) recovery file(entity secret を失うと復旧不可。安全に保管):");
  console.log("----- BEGIN RECOVERY FILE -----");
  console.log(recoveryFile);
  console.log("----- END RECOVERY FILE -----");
  console.log(
    "\n注意: これらの秘密値はリポジトリ/.env/コミットに残さないこと。登録は非冪等(再実行で" +
      "上書きされる)。次に CIRCLE_ENTITY_SECRET_TEST を env に設定し、arc:create-wallets を実行。"
  );
}

main().catch((err) => {
  console.error("[ARC-SETUP] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
