/**
 * Arc Testnet 用の Circle 認証(TEST キー)。
 *
 * AA 本体の本番決済が読む LIVE 認証(circle/client.ts の CIRCLE_API_KEY /
 * CIRCLE_ENTITY_SECRET)とは別の env を読む。Circle は TEST_API_KEY でしか testnet
 * (ARC-TESTNET)を叩けない(LIVE キーだと HTTP 400 / code 156006)。そのため arc スクリプト
 * 専用にここを分け、LIVE へのフォールバックはしない(フォールバックすると 156006 が再発する)。
 *
 * 公開鍵取得と暗号化ロジックは circle/client.ts の共通関数を流用する(chain 非依存)。
 * arc スクリプトは one-off の独立プロセスで、AA 本体(LIVE 経路)とは同一プロセスで走らない。
 */
import { fetchCirclePublicKey, encryptEntitySecret } from "./client";

/** Arc 用の TEST API キー。未設定なら停止(LIVE へフォールバックしない)。 */
export function getRequiredArcTestApiKey(): string {
  const key = process.env.CIRCLE_API_KEY_TEST;
  if (!key) {
    throw new Error(
      "CIRCLE_API_KEY_TEST is required for Arc Testnet " +
        "(Circle Console の Testnet で発行した TEST_API_KEY)。" +
        "LIVE の CIRCLE_API_KEY へはフォールバックしません(testnet だと Circle 156006 になるため)。"
    );
  }
  return key;
}

/** Arc 用の TEST entity secret を暗号化する。未設定なら停止(LIVE へフォールバックしない)。 */
export async function buildArcTestEntitySecretCiphertext(apiKey: string): Promise<string> {
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET_TEST;
  if (!entitySecret) {
    throw new Error(
      "CIRCLE_ENTITY_SECRET_TEST is required for Arc Testnet。" +
        "LIVE の CIRCLE_ENTITY_SECRET へはフォールバックしません。"
    );
  }
  const pubKey = await fetchCirclePublicKey(apiKey);
  return encryptEntitySecret(entitySecret, pubKey);
}
