/**
 * Where an MXE run stopped, named from its record.
 *
 * Read from the error the record already carries, so it applies to every
 * record ever written, not only to new ones. New records also store it
 * (`MxeTradeRecord.stage`), and that stored value wins.
 *
 *   setup          the MXE or a wallet was not available; nothing was queued
 *   rpc            an RPC call failed before or around queueing
 *   queue          the queue transaction failed
 *   callback_wait  queued, but the cluster never finalized it (timed out)
 *   callback_tx    finalized, but the callback transaction failed
 *   read_result    the callback ran but its result could not be read
 *   payment        the computation succeeded; the x402 payment failed
 *   paused         not run: the function is paused after repeated failures
 */
import type { MxeTradeRecord } from "./record";

export type MxeStage =
  | "setup"
  | "rpc"
  | "queue"
  | "callback_wait"
  | "callback_tx"
  | "read_result"
  | "payment"
  | "paused";

export const STAGE_LABELS: Record<MxeStage, string> = {
  setup: "準備(MXE・ウォレット)",
  rpc: "RPC",
  queue: "計算の投入",
  callback_wait: "コールバック待ち",
  callback_tx: "コールバック tx",
  read_result: "結果の読み取り",
  payment: "x402 の支払い",
  paused: "停止中",
};

export function stageOf(r: Pick<MxeTradeRecord, "status" | "error" | "stage">): MxeStage | undefined {
  if (r.stage) return r.stage;
  if (r.status === "paused") return "paused";
  if (r.status !== "failed") return undefined;
  const e = r.error ?? "";
  if (/^payment failed/.test(e)) return "payment";
  if (/not finalized/.test(e)) return "callback_wait";
  if (/callback tx failed|6204/.test(e)) return "callback_tx";
  if (/expected \w+Event|carries a .* event|not settled after|no transaction on the computation account/.test(e)) return "read_result";
  if (/queue tx failed/.test(e)) return "queue";
  if (/MXE unavailable|wallet|not found|MXE_DEVNET_KEYPAIR|Circle/i.test(e)) return "setup";
  if (/block time|429|fetch failed|ECONN|timed? ?out|RPC|Block not available/i.test(e)) return "rpc";
  return "queue";
}

export interface StageSummary {
  stage: MxeStage;
  label: string;
  count: number;
  /** Functions that failed at this stage, ascending. */
  fns: number[];
  first: string;
  last: string;
  /** One error as it was recorded (the newest). */
  sample: string;
}

/** Failed (and paused) records since `sinceIso`, grouped by stage, largest first. */
export function failuresByStage(records: MxeTradeRecord[], sinceIso: string): StageSummary[] {
  const since = Date.parse(sinceIso);
  const out = new Map<MxeStage, StageSummary>();
  for (const r of records) {
    if (Date.parse(r.at) < since) continue;
    const stage = stageOf(r);
    if (!stage) continue;
    const s = out.get(stage) ?? { stage, label: STAGE_LABELS[stage], count: 0, fns: [], first: r.at, last: r.at, sample: "" };
    s.count++;
    if (!s.fns.includes(r.fn)) s.fns.push(r.fn);
    if (r.at < s.first) s.first = r.at;
    if (r.at >= s.last) {
      s.last = r.at;
      s.sample = (r.error ?? "").slice(0, 200);
    }
    out.set(stage, s);
  }
  return [...out.values()].map((s) => ({ ...s, fns: s.fns.sort((a, b) => a - b) })).sort((a, b) => b.count - a.count);
}
