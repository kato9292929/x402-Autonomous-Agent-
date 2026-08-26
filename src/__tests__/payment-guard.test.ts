/**
 * Self-payment guard. Every check here must reject *before* signing, so the
 * tests assert on what the guard does rather than on any downstream effect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guardPayment,
  withinSessionCap,
  priceOf,
  PaymentDeclined,
  TESTNET_NETWORK,
  type GuardDeps,
} from "../payment-guard";
import type { PaymentRequirements } from "@x402/core/types";

function req(over: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: TESTNET_NETWORK,
    amount: "10000", // $0.01
    payTo: "0xPayee",
    ...over,
  } as unknown as PaymentRequirements;
}

function deps(over: Partial<GuardDeps> = {}): GuardDeps & { entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  return {
    session: { limit: 1, spent: 0 },
    allowedNetworks: [TESTNET_NETWORK],
    isFirstSeen: (p) => !seen.has(p),
    markSeen: (p) => void seen.add(p),
    requestApproval: async () => true,
    audit: (e) => void entries.push(e),
    entries,
    ...over,
  };
}

test("priceOf: v2 の amount と v1 の maxAmountRequired の両方を読む", () => {
  assert.equal(priceOf(req({ amount: "20000" })), 0.02);
  assert.equal(priceOf(req({ amount: undefined, maxAmountRequired: "10000" })), 0.01);
  assert.equal(priceOf(req({ amount: undefined })), undefined);
});

test("withinSessionCap: 境界は通し、超過は弾く", () => {
  assert.equal(withinSessionCap({ limit: 1, spent: 0.99 }, 0.01), true);
  assert.equal(withinSessionCap({ limit: 1, spent: 0.99 }, 0.02), false);
  assert.equal(withinSessionCap({ limit: 1, spent: 0 }, NaN), false);
});

test("mainnet を提示されたら halt する(実マネーを払わない)", async () => {
  const d = deps();
  await assert.rejects(
    () => guardPayment(req({ network: "eip155:8453" }), d),
    (e: unknown) => e instanceof PaymentDeclined && e.reason === "halt_network"
  );
  assert.equal(d.session.spent, 0); // 加算もしない
  assert.equal(d.entries[0]?.kind, "halt");
});

test("exact 以外の scheme も halt", async () => {
  await assert.rejects(
    () => guardPayment(req({ scheme: "upto" }), deps()),
    (e: unknown) => e instanceof PaymentDeclined && e.reason === "halt_network"
  );
});

test("session 上限を超えたら decline し、spent を増やさない", async () => {
  const d = deps({ session: { limit: 0.015, spent: 0.01 } });
  await assert.rejects(
    () => guardPayment(req(), d),
    (e: unknown) => e instanceof PaymentDeclined && e.reason === "session_cap"
  );
  assert.equal(d.session.spent, 0.01);
});

test("金額が読めない要件は払わない", async () => {
  await assert.rejects(
    () => guardPayment(req({ amount: undefined }), deps()),
    (e: unknown) => e instanceof PaymentDeclined && e.reason === "session_cap"
  );
});

test("初回の payee は人間承認を待ち、却下されたら払わない", async () => {
  let asked = 0;
  const d = deps({
    requestApproval: async () => {
      asked++;
      return false;
    },
  });
  await assert.rejects(
    () => guardPayment(req(), d),
    (e: unknown) => e instanceof PaymentDeclined && e.reason === "human_rejected"
  );
  assert.equal(asked, 1);
  assert.equal(d.session.spent, 0);
});

test("承認されれば通り、2回目の同じ payee は再承認を求めない", async () => {
  let asked = 0;
  const d = deps({
    requestApproval: async () => {
      asked++;
      return true;
    },
  });
  await guardPayment(req(), d);
  await guardPayment(req(), d);
  assert.equal(asked, 1, "同じ payee への再承認は求めない");
  assert.ok(Math.abs(d.session.spent - 0.02) < 1e-9);
});

test("非執行(decline)も監査に1件残る", async () => {
  const d = deps({ session: { limit: 0, spent: 0 } });
  await assert.rejects(() => guardPayment(req(), d));
  assert.equal(d.entries.length, 1);
  assert.equal(d.entries[0]?.reason, "session_cap");
});

test("監査エントリに鍵素材が入らない(金額・宛先・ネットワークのみ)", async () => {
  const d = deps();
  await guardPayment(req(), d);
  const dumped = JSON.stringify(d.entries);
  for (const forbidden of ["privateKey", "entitySecret", "apiKey", "signature", "0x1234"]) {
    assert.ok(!dumped.includes(forbidden), `${forbidden} が監査に漏れている`);
  }
});
