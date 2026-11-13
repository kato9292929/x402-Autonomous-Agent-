/**
 * Failure stages (from the errors the 11/5–11/13 records actually carry) and
 * the breaker that pauses a function after three run days failing the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageOf } from "../mxe/stage";
import { shouldPause } from "../mxe/breaker";
import { offsetsOf } from "../mxe/rent";
import type { MxeTradeRecord } from "../mxe/record";

const rec = (at: string, fn: 1 | 5, status: MxeTradeRecord["status"], error?: string): MxeTradeRecord => ({
  at,
  fn,
  label: "",
  status,
  network: "arcium-devnet",
  counterparty: "internal",
  error,
});
const WAIT = "not finalized: Error: Computation did not finalize within 300000ms (status: queued)";

test("stages are read from the errors the records carry", () => {
  assert.equal(stageOf(rec("2026-11-12T22:30:00Z", 1, "failed", WAIT)), "callback_wait");
  assert.equal(stageOf(rec("2026-11-04T22:30:00Z", 1, "failed", "failed to get block time for slot 518728335: Block not available for slot 518728335")), "rpc");
  assert.equal(stageOf(rec("x", 1, "failed", "payment failed: insufficient USDC")), "payment");
  assert.equal(stageOf(rec("x", 1, "failed", 'callback tx failed: {"InstructionError":[0,{"Custom":6204}]}')), "callback_tx");
  assert.equal(stageOf(rec("x", 1, "failed", "expected negotiationSettledEvent, callback emitted nothing")), "read_result");
  assert.equal(stageOf(rec("x", 1, "failed", "queue tx failed: {}")), "queue");
  assert.equal(stageOf(rec("x", 1, "failed", "MXE unavailable: MXE_DEVNET_KEYPAIR is not JSON")), "setup");
  assert.equal(stageOf(rec("x", 1, "ok")), undefined);
  assert.equal(stageOf({ ...rec("x", 1, "failed", WAIT), stage: "payment" }), "payment", "a stored stage wins");
});

// Runs at 07:30 JST = 22:30 UTC the day before.
const day = (d: number, fn: 1 | 5 = 1, status: MxeTradeRecord["status"] = "failed", error = WAIT) =>
  rec(`2026-11-${String(d).padStart(2, "0")}T22:30:00Z`, fn, status, error);

test("three run days failing at one stage pause the function", () => {
  const p = shouldPause([day(6), day(7), day(8)], 1);
  assert.ok(p);
  assert.equal(p!.stage, "callback_wait");
  assert.deepEqual(p!.days, ["2026-11-07", "2026-11-08", "2026-11-09"]);
});

test("two days, a success, or mixed stages do not", () => {
  assert.equal(shouldPause([day(7), day(8)], 1), undefined);
  assert.equal(shouldPause([day(6), day(7, 1, "ok"), day(8)], 1), undefined);
  assert.equal(shouldPause([day(6), day(7, 1, "failed", "payment failed: x"), day(8)], 1), undefined);
  assert.equal(shouldPause([day(6, 5), day(7, 5), day(8, 5)], 1), undefined, "other functions do not count");
});

test("only the last three run days count", () => {
  assert.ok(shouldPause([day(3, 1, "ok"), day(6), day(7), day(8)], 1));
});

test("function 5's four searches a day must all fail the same way", () => {
  const f5 = (d: number, okOne = false) => [0, 1, 2, 3].map((i) => day(d, 5, okOne && i === 0 ? "ok" : "failed"));
  assert.ok(shouldPause([...f5(6), ...f5(7), ...f5(8)], 5));
  assert.equal(shouldPause([...f5(6), ...f5(7, true), ...f5(8)], 5), undefined);
});

test("runs before a resume do not count", () => {
  const runs = [day(6), day(7), day(8)];
  assert.equal(shouldPause(runs, 1, { resumedAt: "2026-11-08T00:00:00Z" }), undefined);
  assert.ok(shouldPause([...runs, day(9), day(10)], 1, { resumedAt: "2026-11-07T00:00:00Z" }));
});

test("paused records are not counted as failures", () => {
  const paused = [6, 7, 8].map((d) => ({ ...day(d), status: "paused" as const }));
  assert.equal(shouldPause(paused, 1), undefined);
});

test("rent sweep reads every computation offset from recent devnet records", () => {
  const now = new Date().toISOString();
  const r: MxeTradeRecord = {
    ...rec(now, 1, "ok"),
    computationOffset: "3",
    computations: [
      { circuit: "seal_floor", offset: "1", account: "a", queueTx: "q" },
      { circuit: "match_ceiling", offset: "3", account: "b", queueTx: "q" },
    ],
  };
  const old: MxeTradeRecord = { ...rec("2020-01-01T00:00:00Z", 1, "ok"), computationOffset: "9" };
  assert.deepEqual(offsetsOf([r, old]).sort(), ["1", "3"]);
});
