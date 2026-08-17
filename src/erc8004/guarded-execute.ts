/**
 * 予算を強制した上でレジストリ書き込みを実行し、実行記録を追記する共通経路。
 *
 * 手順:
 *  1. 書き込み前: gasPrice(実チェーン値) × gas 上限単位 = 保守的な見積もり USD を出し、
 *     1tx 上限 / 通算上限を checkBudget で判定。超えるなら送信せず skipped_budget を記録。
 *  2. 送信 → txHash 確定。
 *  3. 書き込み後: receipt の gasUsed × effectiveGasPrice から gas 実額を算出し、
 *     通算に加算して success を記録。
 *  4. 例外時は握りつぶさず failed を記録した上で再 throw する。
 *
 * 見積もりは「上振れ側に倒した天井」を使う。calldata を自前でエンコードして
 * eth_estimateGas を引くと Circle DCW が実際に送る calldata と乖離しうるため、
 * 予算ガードとしては安全側(過大評価)の天井で判定する。天井は ERC8004_GAS_MAX_UNITS で上書き可。
 */
import {
  submitContractExecution,
  waitForTxHash,
  getGasActual,
  getGasPriceWei,
} from "./arc-tx";
import {
  gasCostUsd,
  checkBudget,
  assertWithinBudget,
  resolveUsdPerNative,
} from "./gas-budget";
import {
  appendRunEntry,
  loadSpentUsd,
  addSpentUsd,
  type RegistryName,
} from "./registry-run-log";

/** 見積もりに使う gas 単位の天井(保守的)。実測が出たら記録側で実額に置き換わる。 */
export const GAS_CEILING_UNITS = BigInt(process.env.ERC8004_GAS_MAX_UNITS ?? "500000");

export interface GuardedExecuteInput {
  chain: string;
  registry: RegistryName;
  registryAddress: string;
  abiFunctionSignature: string;
  abiParameters: unknown[];
  walletId: string;
  /** 対象エントリの識別子(agentId / requestHash など)。実行記録に残す。 */
  subject: string;
  /** ライブ未検証の分岐ラベル。実行記録に残す。 */
  unverified?: string[];
  explorerUrl?: (txHash: string) => string;
}

export interface GuardedExecuteResult {
  txHash: string;
  gasCostUsd: number;
  cumulativeUsd: number;
}

export async function guardedExecute(
  input: GuardedExecuteInput
): Promise<GuardedExecuteResult> {
  const usdPerNative = resolveUsdPerNative(input.chain);
  const spentUsd = await loadSpentUsd();

  // ── 1. 書き込み前チェック(保守的な天井で判定) ─────────────────────────────
  const gasPriceWei = await getGasPriceWei();
  const projectedUsd = gasCostUsd(GAS_CEILING_UNITS, gasPriceWei, usdPerNative);
  const check = checkBudget(projectedUsd, spentUsd);
  if (!check.allowed) {
    await appendRunEntry({
      at: new Date().toISOString(),
      chain: input.chain,
      registry: input.registry,
      registry_address: input.registryAddress,
      fn: input.abiFunctionSignature,
      subject: input.subject,
      result: "skipped_budget",
      gas_price_wei: gasPriceWei.toString(),
      cumulative_usd: spentUsd,
      error: check.reason,
      unverified: input.unverified,
    });
    assertWithinBudget(check); // 握りつぶさず失敗させる
  }
  console.log(
    `[ERC8004] budget ok: 見積上限 $${projectedUsd.toFixed(6)} / 通算 $${spentUsd.toFixed(6)} ` +
      `(残り $${check.remainingUsd.toFixed(4)})`
  );

  // ── 2. 送信 ────────────────────────────────────────────────────────────────
  let txHash: string;
  try {
    const txId = await submitContractExecution({
      walletId: input.walletId,
      contractAddress: input.registryAddress,
      abiFunctionSignature: input.abiFunctionSignature,
      abiParameters: input.abiParameters,
    });
    txHash = await waitForTxHash(txId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendRunEntry({
      at: new Date().toISOString(),
      chain: input.chain,
      registry: input.registry,
      registry_address: input.registryAddress,
      fn: input.abiFunctionSignature,
      subject: input.subject,
      result: "failed",
      gas_price_wei: gasPriceWei.toString(),
      cumulative_usd: spentUsd,
      error: message,
      unverified: input.unverified,
    });
    throw err;
  }

  // ── 3. gas 実額 → 通算に加算 → success を記録 ──────────────────────────────
  const actual = await getGasActual(txHash);
  const actualUsd = gasCostUsd(actual.gasUnits, actual.gasPriceWei, usdPerNative);
  const cumulativeUsd = await addSpentUsd(actualUsd);

  await appendRunEntry({
    at: new Date().toISOString(),
    chain: input.chain,
    registry: input.registry,
    registry_address: input.registryAddress,
    fn: input.abiFunctionSignature,
    subject: input.subject,
    result: "success",
    tx_hash: txHash,
    gas_units: actual.gasUnits.toString(),
    gas_price_wei: actual.gasPriceWei.toString(),
    gas_cost_usd: actualUsd,
    cumulative_usd: cumulativeUsd,
    explorer_url: input.explorerUrl?.(txHash),
    unverified: input.unverified,
  });

  return { txHash, gasCostUsd: actualUsd, cumulativeUsd };
}
