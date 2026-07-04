/**
 * Arc の Validation を1往復通す(owner が request → validator が response)。
 *
 * response 値は捏造せず、M0 で登録済みの identity(agentId)を根拠にする(登録記録が存在する
 * ことを検証根拠にし、response=1=valid)。
 *
 * 実行(Railway):
 *   node dist/scripts/arc-run-validation.js
 * 必要 env:
 *   CIRCLE_API_KEY_TEST, CIRCLE_ENTITY_SECRET_TEST,
 *   CIRCLE_ARC_OWNER_WALLET_ID, CIRCLE_ARC_VALIDATOR_WALLET_ID, ARC_VALIDATOR_ADDRESS
 * 任意 env:
 *   ARC_AGENT_ID(未指定なら M0 記録の arc_agent_id、無ければ 845265)
 */
import "dotenv/config";
import { loadArcRegistration, saveArcValidation } from "../erc8004/arc-record";
import { runValidation } from "../erc8004/arc-validation";
import { getValidatorAddress } from "../erc8004/arc-tx";
import { arcTxUrl } from "../erc8004/arc-contract";

async function main(): Promise<void> {
  const reg = await loadArcRegistration();
  const agentId = process.env.ARC_AGENT_ID ?? reg?.arc_agent_id ?? "845265";
  const validatorAddress = getValidatorAddress();

  // 検証根拠: M0 identity 登録が存在するか(捏造しない)。存在すれば valid(1)。
  const hasIdentity = Boolean(reg?.arc_agent_id);
  const response = hasIdentity ? 1 : 0;
  const now = new Date().toISOString();

  const result = await runValidation({
    agentId,
    validatorAddress,
    requestURI: "",
    responseURI: "",
    requestPayload: {
      agentId,
      validator: validatorAddress,
      purpose: "identity-liveness-check",
      requestedAt: now,
    },
    responsePayload: {
      verified: hasIdentity,
      basis: "m0-identity-registration",
      identity_tx: reg?.tx_hash ?? null,
      agentId,
      respondedAt: now,
    },
    response,
    tag: "identity",
  });

  await saveArcValidation({
    chain: "ARC-TESTNET",
    arc_agent_id: agentId,
    request_hash: result.requestHash,
    request_tx_hash: result.requestTxHash,
    response_tx_hash: result.responseTxHash,
    response: result.response,
    tag: "identity",
    explorer_request_url: arcTxUrl(result.requestTxHash),
    explorer_response_url: arcTxUrl(result.responseTxHash),
    recorded_at: now,
  });

  console.log(`\n[ARC-VAL] request tx : ${arcTxUrl(result.requestTxHash)}`);
  console.log(`[ARC-VAL] response tx: ${arcTxUrl(result.responseTxHash)}`);
  console.log(`[ARC-VAL] requestHash=${result.requestHash} response=${result.response}`);
  console.log("[ARC-VAL] arcscan で両 tx を確認するまで「記録できた」としないこと。");
}

main().catch((err) => {
  console.error("[ARC-VAL] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
