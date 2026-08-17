/**
 * ERC-8004 Validation(Arc Testnet)。二段階フローを1往復通す。
 *
 * 1) owner ウォレットで validationRequest(validatorAddress, agentId, requestURI, requestHash)
 * 2) validator ウォレットで validationResponse(requestHash, response, responseURI, responseHash, tag)
 *
 * requestHash は request 内容(JSON)の keccak256 で自分で決め、response でも同じ値を使う
 * (event 抽出は不要)。response 値は捏造せず、M0 で登録済みの identity(agentId)を根拠にする。
 *
 * 関数は erc-8004-contracts の ValidationRegistry ABI で一次確認済み(arc-contract.ts)。
 */
import { keccak256, toBytes } from "viem";
import {
  ARC_VALIDATION_REGISTRY,
  ARC_VALIDATION_REQUEST_SIG,
  ARC_VALIDATION_RESPONSE_SIG,
  ARC_CIRCLE_BLOCKCHAIN,
  arcTxUrl,
} from "./arc-contract";
import { getOwnerWalletId, getValidatorWalletId } from "./arc-tx";
import { guardedExecute } from "./guarded-execute";

/** 任意 JSON の keccak256(bytes32, 0x…)。requestHash / responseHash に使う。 */
export function hashOf(json: string): string {
  return keccak256(toBytes(json));
}

/**
 * validationResponse の response は 0-100 の整数(一次確認:
 * ValidationRegistryUpgradeable.sol の require(response <= 100, "resp>100"))。
 * 真偽値ではないので 0/1 ではなく 0-100 のスケールで渡す。
 */
export const VALIDATION_RESPONSE_MAX = 100;

/** response が仕様の範囲(0-100 の整数)か検証する。範囲外は送信前に落とす。 */
export function assertValidResponse(response: number): void {
  if (!Number.isInteger(response) || response < 0 || response > VALIDATION_RESPONSE_MAX) {
    throw new Error(
      `validationResponse の response は 0-${VALIDATION_RESPONSE_MAX} の整数である必要があります(受領: ${response})`
    );
  }
}

export interface ValidationResult {
  requestHash: string;
  requestTxHash: string;
  responseTxHash: string;
  response: number;
  gasCostUsd: number;
  cumulativeUsd: number;
}

/**
 * validation を1往復通す。
 * @param agentId 対象 agentId
 * @param validatorAddress validator ウォレットのアドレス(validationRequest の引数)
 * @param requestPayload request の根拠 JSON(hash 計算に使う)
 * @param responsePayloadFactory requestHash を受けて response 根拠 JSON を返す
 * @param response uint8 の検証結果(捏造せず、実根拠に基づく値)
 */
export async function runValidation(input: {
  agentId: string;
  validatorAddress: string;
  requestURI: string;
  responseURI: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
  response: number;
  tag: string;
}): Promise<ValidationResult> {
  assertValidResponse(input.response);

  const requestJson = JSON.stringify(input.requestPayload);
  const requestHash = hashOf(requestJson);

  // 1) validationRequest は owner ウォレットから送る。
  //    一次確認(ValidationRegistryUpgradeable.sol):
  //      require(msg.sender == owner || isApprovedForAll(owner, msg.sender)
  //              || getApproved(agentId) == msg.sender, "Not authorized")
  //    → validator ウォレットからは送れない(コントラクトが拒否する)。
  //    reputation(giveFeedback)は逆に owner から送れないため、役割は自然に分離される。
  // UNVERIFIED(ライブ未検証): 実送信・revert 分岐は環境B未消化。
  const req = await guardedExecute({
    chain: ARC_CIRCLE_BLOCKCHAIN,
    registry: "ValidationRegistry",
    registryAddress: ARC_VALIDATION_REGISTRY,
    abiFunctionSignature: ARC_VALIDATION_REQUEST_SIG,
    abiParameters: [input.validatorAddress, input.agentId, input.requestURI, requestHash],
    walletId: getOwnerWalletId(),
    subject: `agentId=${input.agentId} requestHash=${requestHash}`,
    unverified: ["validationRequest-live-unverified"],
    explorerUrl: arcTxUrl,
  });
  console.log(`[ARC-VAL] request confirmed: ${req.txHash} (requestHash=${requestHash})`);

  // 2) validator が validationResponse(同じ requestHash を参照)
  //    一次確認: require(msg.sender == s.validatorAddress, "not validator")
  //              require(response <= 100, "resp>100")
  const responseHash = hashOf(JSON.stringify({ ...input.responsePayload, requestHash }));
  const res = await guardedExecute({
    chain: ARC_CIRCLE_BLOCKCHAIN,
    registry: "ValidationRegistry",
    registryAddress: ARC_VALIDATION_REGISTRY,
    abiFunctionSignature: ARC_VALIDATION_RESPONSE_SIG,
    abiParameters: [
      requestHash,
      String(input.response), // uint8(0-100)
      input.responseURI,
      responseHash,
      input.tag,
    ],
    walletId: getValidatorWalletId(),
    subject: `requestHash=${requestHash} response=${input.response}`,
    unverified: ["validationResponse-live-unverified"],
    explorerUrl: arcTxUrl,
  });
  console.log(`[ARC-VAL] response confirmed: ${res.txHash}`);

  return {
    requestHash,
    requestTxHash: req.txHash,
    responseTxHash: res.txHash,
    response: input.response,
    gasCostUsd: req.gasCostUsd + res.gasCostUsd,
    cumulativeUsd: res.cumulativeUsd,
  };
}
