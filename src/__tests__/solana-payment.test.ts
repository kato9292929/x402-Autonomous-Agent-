/**
 * Tests for Solana endpoint configuration and chain routing.
 * Uses node:test (Node.js 20+, no extra dependencies).
 *
 * Solana payment logic is now handled by @x402/svm SDK (registerExactSvmScheme).
 * Manual solana-payment.ts has been removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("MODE B has 3 osd Solana endpoints (osd-ipo, osd-holders, osd-liquidity)", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  const solanaEndpoints = ENDPOINTS_MODE_B.filter((e) => e.chain === "solana");
  assert.equal(solanaEndpoints.length, 3, "Should have exactly 3 osd Solana endpoints");

  const ids = solanaEndpoints.map((e) => e.id);
  assert.ok(ids.includes("osd-ipo"), "osd-ipo should be present");
  assert.ok(ids.includes("osd-holders"), "osd-holders should be present");
  assert.ok(ids.includes("osd-liquidity"), "osd-liquidity should be present");

  for (const ep of solanaEndpoints) {
    assert.ok(ep.url.includes("osd-coral.vercel.app"), `${ep.id} must point to osd-coral`);
    assert.equal(ep.method, "GET");
    assert.equal(ep.cost, 0.01);
  }
});

test("MODE B contains both Base and Solana endpoints", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  const chains = new Set(ENDPOINTS_MODE_B.map((e) => e.chain));
  assert.ok(chains.has("base"), "MODE B should have Base endpoints");
  assert.ok(chains.has("solana"), "MODE B should have Solana endpoints");
});

test("PMI (private-market) is not in MODE B", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  const ids = ENDPOINTS_MODE_B.map((e) => e.id);
  assert.ok(!ids.includes("private-market"), "PMI should have been removed");
});

test("MODE B has 14 endpoints total", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  assert.equal(ENDPOINTS_MODE_B.length, 14, "Should have 11 Base + 3 Solana = 14 endpoints");
});
