/**
 * Arc Testnet に AA の ERC-8004 identity を登録する(register → agentId 取得 → 記録)。
 *
 * 実行(dist で実証):
 *   node dist/scripts/arc-register-agent.js
 * 必要 env:
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_ARC_OWNER_WALLET_ID(ガス用 USDC 済み)
 * 任意 env:
 *   ARC_METADATA_URI  — 未指定なら AA の agent-card URL を使う
 *   ARC_OWNER_ADDRESS — 記録用(表示のみ)
 *
 * 重要: この tx と agentId を https://testnet.arcscan.app で目視確認するまで「登録完了」と
 * しないこと(自動判定はしない)。
 */
import "dotenv/config";
import { registerArcAgent } from "../erc8004/arc-executor";
import { saveArcRegistration } from "../erc8004/arc-record";
import { ARC_IDENTITY_REGISTRY, ARC_EXPLORER, arcTxUrl } from "../erc8004/arc-contract";

function resolveMetadataURI(): string {
  if (process.env.ARC_METADATA_URI) return process.env.ARC_METADATA_URI;
  const base = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "https://x402-autonomous-agent-production.up.railway.app";
  // AA は /.well-known/agent-card.json を配信済み(ERC-8004 registration-v1 形式)。
  // TODO: Arc の register が期待する形式(HTTP URL か ipfs://)を use-arc Skill / docs で確認。
  //       必要ならチュートリアルの例 URI で疎通確認してから本 URI に差し替える。
  return `${base}/.well-known/agent-card.json`;
}

async function main(): Promise<void> {
  const metadataURI = resolveMetadataURI();
  console.log(`[ARC] register-your-first-ai-agent`);
  console.log(`[ARC] IdentityRegistry=${ARC_IDENTITY_REGISTRY}`);
  console.log(`[ARC] metadataURI=${metadataURI}`);

  const { agentId, txHash } = await registerArcAgent(metadataURI);

  await saveArcRegistration({
    chain: "ARC-TESTNET",
    arc_agent_id: agentId, // Base の 55560 とは別物
    tx_hash: txHash,
    identity_registry: ARC_IDENTITY_REGISTRY,
    metadata_uri: metadataURI,
    explorer_tx_url: arcTxUrl(txHash),
    owner_wallet_id: process.env.CIRCLE_ARC_OWNER_WALLET_ID,
    owner_address: process.env.ARC_OWNER_ADDRESS,
    base_agent_id: process.env.ERC8004_AGENT_ID ?? "55560",
    registered_at: new Date().toISOString(),
  });

  console.log(`\n[ARC] Arc agentId=${agentId}`);
  console.log(`[ARC] tx: ${arcTxUrl(txHash)}`);
  console.log(
    `[ARC] 次のステップ: 上記 tx を ${ARC_EXPLORER} で開き、tx と agentId(ownerOf/tokenURI)を` +
      ` 目視確認するまで「登録完了」としないこと。`
  );
}

main().catch((err) => {
  console.error("[ARC] register failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
