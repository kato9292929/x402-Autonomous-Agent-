/**
 * One-shot: Arc Testnet の owner / validator ウォレットを Circle DCW で作成する。
 *
 * ERC-8004 では agent owner は自分の agent に reputation を付けられない(self-dealing 防止)
 * ため、owner と validator の2ウォレットが要る。今回のスコープ(identity 登録)では owner を
 * 使い、validator は次段(reputation)用に併せて作る。
 *
 * 実行(dist で実証):
 *   node dist/scripts/arc-create-wallets.js
 * 必要 env (Arc は Circle TEST キー。AA 本体の LIVE 認証とは別):
 *   CIRCLE_API_KEY_TEST, CIRCLE_ENTITY_SECRET_TEST, CIRCLE_WALLET_SET_ID
 *   ※ LIVE キーだと testnet で HTTP 400 / code 156006 になるため TEST キーが必須。
 *
 * 出力の4値を Railway Variables 等に設定する。
 */
import "dotenv/config";
import * as crypto from "node:crypto";
import { CIRCLE_API } from "../circle/client";
import {
  getRequiredArcTestApiKey,
  buildArcTestEntitySecretCiphertext,
} from "../circle/arc-test-client";
import { ARC_CIRCLE_BLOCKCHAIN, ARC_FAUCET } from "../erc8004/arc-contract";

async function main(): Promise<void> {
  const apiKey = getRequiredArcTestApiKey();
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!walletSetId) {
    console.error("ERROR: CIRCLE_WALLET_SET_ID is required");
    process.exit(1);
  }

  const entitySecretCiphertext = await buildArcTestEntitySecretCiphertext(apiKey);
  console.log(
    `Creating 2 ${ARC_CIRCLE_BLOCKCHAIN} SCA wallets (owner, validator) in wallet set ${walletSetId} ...`
  );

  const res = await fetch(`${CIRCLE_API}/developer/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      entitySecretCiphertext,
      walletSetId,
      blockchains: [ARC_CIRCLE_BLOCKCHAIN],
      accountType: "SCA",
      count: 2,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Circle API error: HTTP ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  let json: { data?: { wallets?: Array<{ id: string; address: string }> } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    console.error("Failed to parse Circle API response:");
    console.error(text);
    process.exit(1);
  }

  const wallets = json.data?.wallets ?? [];
  if (wallets.length < 2) {
    console.error("Expected 2 wallets in response:");
    console.error(text);
    process.exit(1);
  }

  const [owner, validator] = wallets;
  console.log("\n=== Arc Testnet wallets created ===");
  console.log(`CIRCLE_ARC_OWNER_WALLET_ID=${owner.id}`);
  console.log(`ARC_OWNER_ADDRESS=${owner.address}`);
  console.log(`CIRCLE_ARC_VALIDATOR_WALLET_ID=${validator.id}`);
  console.log(`ARC_VALIDATOR_ADDRESS=${validator.address}`);
  console.log(
    `\n次: 両アドレスに ${ARC_FAUCET} で testnet USDC を入れてガスを用意(または Gas Station でスポンサー)。`
  );
  console.log("その後 env に上記4値を設定し、arc:register を実行する。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
