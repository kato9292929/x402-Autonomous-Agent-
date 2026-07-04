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
} from "./arc-contract";
import {
  getOwnerWalletId,
  getValidatorWalletId,
  submitContractExecution,
  waitForTxHash,
} from "./arc-tx";

/** 任意 JSON の keccak256(bytes32, 0x…)。requestHash / responseHash に使う。 */
export function hashOf(json: string): string {
  return keccak256(toBytes(json));
}

export interface ValidationResult {
  requestHash: string;
  requestTxHash: string;
  responseTxHash: string;
  response: number;
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
  const requestJson = JSON.stringify(input.requestPayload);
  const requestHash = hashOf(requestJson);

  // 1) owner が validationRequest
  const reqTxId = await submitContractExecution({
    walletId: getOwnerWalletId(),
    contractAddress: ARC_VALIDATION_REGISTRY,
    abiFunctionSignature: ARC_VALIDATION_REQUEST_SIG,
    abiParameters: [input.validatorAddress, input.agentId, input.requestURI, requestHash],
  });
  console.log(`[ARC-VAL] validationRequest submitted: ${reqTxId}`);
  const requestTxHash = await waitForTxHash(reqTxId);
  console.log(`[ARC-VAL] request confirmed: ${requestTxHash} (requestHash=${requestHash})`);

  // 2) validator が validationResponse(同じ requestHash を参照)
  const responseHash = hashOf(JSON.stringify({ ...input.responsePayload, requestHash }));
  const resTxId = await submitContractExecution({
    walletId: getValidatorWalletId(),
    contractAddress: ARC_VALIDATION_REGISTRY,
    abiFunctionSignature: ARC_VALIDATION_RESPONSE_SIG,
    abiParameters: [
      requestHash,
      String(Math.trunc(input.response)), // uint8
      input.responseURI,
      responseHash,
      input.tag,
    ],
  });
  console.log(`[ARC-VAL] validationResponse submitted: ${resTxId}`);
  const responseTxHash = await waitForTxHash(resTxId);
  console.log(`[ARC-VAL] response confirmed: ${responseTxHash}`);

  return { requestHash, requestTxHash, responseTxHash, response: input.response };
}
