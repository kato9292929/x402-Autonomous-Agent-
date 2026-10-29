/**
 * Arc 用の Circle 認証。ARC_NETWORK に応じて厳密に選ぶ:
 *   - testnet(既定): TEST キー(CIRCLE_API_KEY_TEST / CIRCLE_ENTITY_SECRET_TEST)
 *   - mainnet       : LIVE キー(CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET)
 *
 * TEST↔LIVE は決して相互フォールバックしない。testnet で LIVE キーを使うと Circle 156006、
 * mainnet で TEST キーを使うと本番チェーンを叩けない。網の取り違えは大きく失敗させる。
 * ネットワークは呼び出し時に process.env.ARC_NETWORK で判定する(env をプロセス起動後に
 * 差し替えるテストにも追従するため)。
 *
 * 公開鍵取得と暗号化ロジックは circle/client.ts の共通関数を流用する(chain 非依存)。
 * arc スクリプトは one-off の独立プロセスで、AA 本体(LIVE 決済経路)とは別プロセスで走る。
 */
import { fetchCirclePublicKey, encryptEntitySecret } from "./client";

function arcIsMainnet(): boolean {
  return process.env.ARC_NETWORK === "mainnet";
}

/**
 * Arc 用の API キー。ネットワークに応じた env のみ読み、他方へフォールバックしない。
 * (関数名は後方互換で残置。testnet/mainnet 両対応。)
 */
export function getRequiredArcTestApiKey(): string {
  if (arcIsMainnet()) {
    const key = process.env.CIRCLE_API_KEY;
    if (!key) {
      throw new Error(
        "CIRCLE_API_KEY is required for Arc mainnet (ARC_NETWORK=mainnet)。" +
          "TEST の CIRCLE_API_KEY_TEST へはフォールバックしません。"
      );
    }
    return key;
  }
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

/** Arc 用の entity secret を暗号化する。ネットワークに応じた env のみ読む。 */
export async function buildArcTestEntitySecretCiphertext(apiKey: string): Promise<string> {
  const mainnet = arcIsMainnet();
  const entitySecret = mainnet
    ? process.env.CIRCLE_ENTITY_SECRET
    : process.env.CIRCLE_ENTITY_SECRET_TEST;
  if (!entitySecret) {
    throw new Error(
      mainnet
        ? "CIRCLE_ENTITY_SECRET is required for Arc mainnet。TEST へはフォールバックしません。"
        : "CIRCLE_ENTITY_SECRET_TEST is required for Arc Testnet。LIVE へはフォールバックしません。"
    );
  }
  const pubKey = await fetchCirclePublicKey(apiKey);
  return encryptEntitySecret(entitySecret, pubKey);
}
