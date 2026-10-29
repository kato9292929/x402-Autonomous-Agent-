/**
 * ERC-8004 レジストリ書き込みの gas 予算をコードで強制する。
 *
 * 上限(指示書 2026-08-18):
 *   - 1 トランザクション: $0.10 相当
 *   - 本タスク通算       : $1.00 相当
 * 上限に達したら書き込みを止めて記録を残す。引き上げは人間の判断(env で明示的に上書き)。
 *
 * 設計上の規律:
 *  - USD 換算レートを推測しない。mainnet でレート未指定なら「見積もれない」として
 *    書き込みを拒否する(フォールバックで 0 とみなして通さない)。
 *  - ARC-TESTNET の native token は faucet 配布のテスト用トークンで市場価格を持たない。
 *    これは推測ではなく faucet(https://faucet.circle.com)由来という事実に基づき 0 を既定とする。
 *  - 通算額は永続ストアに追記して跨プロセスで累積する(gas-budget-store.ts)。
 */

/** 1 tx あたりの上限(USD)。既定 $0.10。 */
export const PER_TX_USD_CAP = Number(process.env.ERC8004_GAS_TX_CAP_USD ?? "0.10");
/** 本タスク通算の上限(USD)。既定 $1.00。 */
export const TOTAL_USD_CAP = Number(process.env.ERC8004_GAS_TOTAL_CAP_USD ?? "1.00");

const WEI_PER_NATIVE = 1e18;

/** テストネットの native token は市場価格を持たない(faucet 配布)。 */
const ZERO_PRICE_CHAINS = new Set(["ARC-TESTNET"]);

export class GasBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GasBudgetError";
  }
}

/**
 * native token の USD レートを解決する。
 * 推測しない: 価格を持たないと分かっているテストネット以外は env 明示が必須。
 * @throws GasBudgetError レートが解決できない場合(=見積もれないので書き込ませない)
 */
export function resolveUsdPerNative(chain: string): number {
  const raw = process.env.ERC8004_GAS_USD_PER_NATIVE;
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) {
      throw new GasBudgetError(`ERC8004_GAS_USD_PER_NATIVE が不正: ${raw}`);
    }
    return v;
  }
  if (ZERO_PRICE_CHAINS.has(chain)) return 0;
  throw new GasBudgetError(
    `${chain} の native token の USD レートが未指定です。ERC8004_GAS_USD_PER_NATIVE を設定してください` +
      ` (推測で 0 とみなして書き込むことはしません)`
  );
}

/** gasUsed(単位) × gasPrice(wei) を USD に換算する純関数。 */
export function gasCostUsd(gasUnits: bigint, gasPriceWei: bigint, usdPerNative: number): number {
  const wei = gasUnits * gasPriceWei;
  return (Number(wei) / WEI_PER_NATIVE) * usdPerNative;
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  projectedUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

/**
 * 書き込み前チェック(純関数)。1tx 上限と通算上限の両方を判定する。
 * @param projectedUsd この tx の見積もり USD
 * @param spentUsd     これまでの通算 USD
 */
export function checkBudget(
  projectedUsd: number,
  spentUsd: number,
  perTxCap = PER_TX_USD_CAP,
  totalCap = TOTAL_USD_CAP
): BudgetCheck {
  const remainingUsd = Math.max(0, totalCap - spentUsd);
  if (!Number.isFinite(projectedUsd) || projectedUsd < 0) {
    return {
      allowed: false,
      reason: `見積もりが不正(${projectedUsd})`,
      projectedUsd,
      spentUsd,
      remainingUsd,
    };
  }
  if (projectedUsd > perTxCap) {
    return {
      allowed: false,
      reason: `1tx 上限超過: 見積 $${projectedUsd.toFixed(4)} > 上限 $${perTxCap.toFixed(2)}`,
      projectedUsd,
      spentUsd,
      remainingUsd,
    };
  }
  if (spentUsd >= totalCap) {
    return {
      allowed: false,
      reason: `通算上限に到達済み: 消費 $${spentUsd.toFixed(4)} >= 上限 $${totalCap.toFixed(2)}`,
      projectedUsd,
      spentUsd,
      remainingUsd,
    };
  }
  if (spentUsd + projectedUsd > totalCap) {
    return {
      allowed: false,
      reason:
        `通算上限超過の見込み: 消費 $${spentUsd.toFixed(4)} + 見積 $${projectedUsd.toFixed(4)}` +
        ` > 上限 $${totalCap.toFixed(2)}`,
      projectedUsd,
      spentUsd,
      remainingUsd,
    };
  }
  return { allowed: true, projectedUsd, spentUsd, remainingUsd };
}

/** checkBudget が不許可なら例外にする(握りつぶさず大きく失敗する)。 */
export function assertWithinBudget(check: BudgetCheck): void {
  if (!check.allowed) {
    throw new GasBudgetError(
      `gas 予算により書き込みを中止: ${check.reason} ` +
        `(残り $${check.remainingUsd.toFixed(4)})`
    );
  }
}
