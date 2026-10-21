/**
 * What an MXE run writes down, per computation.
 *
 * The fields follow the integration brief's 記録 list: function number,
 * network, computation id, processing time, cost (SOL / Arcium and USD), the
 * cost-to-price ratio, the result, the comparison side's result, and who the
 * counterparty was.
 *
 * Nothing here is filled in by assumption. A computation id is written only
 * once the queue transaction confirmed; a cost only from a measured balance
 * delta; a failed run is recorded as failed, with the error, and never with a
 * substitute result. "判定は devnet、支払いは mainnet" is kept visible by
 * recording the two networks separately.
 */

export type MxeFunction = 1 | 2 | 3 | 4 | 5;

export const MXE_FUNCTION_LABELS: Record<MxeFunction, string> = {
  1: "留保価格の照合交渉",
  2: "封印見積り RFQ",
  3: "評価者を明かさない売り手スコア",
  4: "参加者を明かさない共同購入",
  5: "検索意図を隠したエンドポイント探索",
};

/** Functions 1, 2 and 4 trade between the AA's own agents (内部取引). */
export const INTERNAL_FUNCTIONS: ReadonlySet<MxeFunction> = new Set<MxeFunction>([1, 2, 4]);

/** Where the computation ran. Distinct from where any payment settled. */
export type MxeNetwork = "arcium-localnet" | "arcium-devnet" | "arcium-mainnet";

export type MxeStatus =
  | "ok" // computation finalized and its callback event was read
  | "failed" // something went wrong; `error` says what. No result is invented.
  | "disabled"; // the function's flag is off; recorded so a gap is visible

/** 相手方の区分. */
export type Counterparty =
  | "internal" // AA's own agents on both sides (functions 1, 2, 4)
  | "self" // the AA alone (function 5's search, function 3's own rating)
  | "external"; // a party outside the AA (function 3's intake API)

export interface MxeComparison {
  /** The public method the sealed one is compared against. */
  method: string;
  result: unknown;
  latencyMs?: number;
  /** What the public method reveals that the sealed one does not. */
  disclosed?: string[];
}

export interface MxeTradeRecord {
  at: string;
  fn: MxeFunction;
  label: string;
  status: MxeStatus;
  network: MxeNetwork;
  /** CAIP-2 of the x402 settlement, when the function paid anything. */
  paymentNetwork?: string;
  /** 計算ID: the computation offset (u64, decimal). Set only after the queue tx confirmed. */
  computationOffset?: string;
  computationAccount?: string;
  queueTx?: string;
  /** Payment transaction(s) on the payment network. */
  paymentTxs?: string[];
  /** Queue → callback event, in ms. */
  latencyMs?: number;
  /** Fee payer's SOL balance delta over the computation, in SOL. */
  costSol?: number;
  /**
   * Fees paid in an Arcium token, if the cluster charged any. `0` when the
   * balance was checked and nothing was charged; undefined when unknown.
   */
  costArcium?: number;
  /** costSol at the SOL/USD price in `solUsd`. */
  costUsd?: number;
  solUsd?: number;
  /** How `costUsd` was priced — devnet SOL has no market value of its own. */
  costUsdBasis?: string;
  /** What was bought (the decided price / share), in USDC. */
  tradeUsd?: number;
  /** 単価比: costUsd / tradeUsd. Undefined when nothing was bought. */
  unitCostRatio?: number;
  result?: unknown;
  comparison?: MxeComparison;
  counterparty: Counterparty;
  error?: string;
}

/** 単価比. Undefined unless both sides are positive, finite numbers. */
export function unitCostRatio(costUsd?: number, tradeUsd?: number): number | undefined {
  if (costUsd === undefined || tradeUsd === undefined) return undefined;
  if (!Number.isFinite(costUsd) || !Number.isFinite(tradeUsd) || tradeUsd <= 0 || costUsd < 0) {
    return undefined;
  }
  return costUsd / tradeUsd;
}

export interface MxeFunctionAggregate {
  fn: MxeFunction;
  label: string;
  runs: number;
  ok: number;
  failed: number;
  disabled: number;
  /** Over `ok` runs that measured it. */
  latencyMs?: { mean: number; min: number; max: number; n: number };
  costUsd?: { mean: number; total: number; n: number };
  costSol?: { mean: number; total: number; n: number };
  unitCostRatio?: { mean: number; n: number };
  /** `ok` runs that also carry a public-method comparison. */
  compared: number;
  networks: MxeNetwork[];
}

function stats(xs: number[]): { mean: number; min: number; max: number; total: number; n: number } | undefined {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return undefined;
  const total = v.reduce((a, b) => a + b, 0);
  return { mean: total / v.length, min: Math.min(...v), max: Math.max(...v), total, n: v.length };
}

/** Per-function aggregates of processing time, cost and 単価比 (完了条件). */
export function aggregateByFunction(records: MxeTradeRecord[]): MxeFunctionAggregate[] {
  return ([1, 2, 3, 4, 5] as MxeFunction[]).map((fn) => {
    const rs = records.filter((r) => r.fn === fn);
    const ok = rs.filter((r) => r.status === "ok");
    const lat = stats(ok.map((r) => r.latencyMs ?? NaN));
    const usd = stats(ok.map((r) => r.costUsd ?? NaN));
    const sol = stats(ok.map((r) => r.costSol ?? NaN));
    const ratio = stats(ok.map((r) => r.unitCostRatio ?? NaN));
    return {
      fn,
      label: MXE_FUNCTION_LABELS[fn],
      runs: rs.length,
      ok: ok.length,
      failed: rs.filter((r) => r.status === "failed").length,
      disabled: rs.filter((r) => r.status === "disabled").length,
      latencyMs: lat && { mean: lat.mean, min: lat.min, max: lat.max, n: lat.n },
      costUsd: usd && { mean: usd.mean, total: usd.total, n: usd.n },
      costSol: sol && { mean: sol.mean, total: sol.total, n: sol.n },
      unitCostRatio: ratio && { mean: ratio.mean, n: ratio.n },
      compared: ok.filter((r) => r.comparison !== undefined).length,
      networks: [...new Set(ok.map((r) => r.network))],
    };
  });
}
