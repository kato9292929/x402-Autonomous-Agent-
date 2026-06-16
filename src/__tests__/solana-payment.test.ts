/**
 * Tests for Solana endpoint configuration and chain routing.
 * Uses node:test (Node.js 20+, no extra dependencies).
 *
 * Solana payment logic is now handled by @x402/svm SDK (registerExactSvmScheme).
 * Manual solana-payment.ts has been removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("MODE B has 5 osd Solana endpoints (osd-ipo, osd-holders, osd-liquidity, osd-jin-latest, osd-jin-movers)", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  const solanaEndpoints = ENDPOINTS_MODE_B.filter((e) => e.chain === "solana");
  assert.equal(solanaEndpoints.length, 5, "Should have exactly 5 osd Solana endpoints");

  const ids = solanaEndpoints.map((e) => e.id);
  assert.ok(ids.includes("osd-ipo"), "osd-ipo should be present");
  assert.ok(ids.includes("osd-holders"), "osd-holders should be present");
  assert.ok(ids.includes("osd-liquidity"), "osd-liquidity should be present");
  assert.ok(ids.includes("osd-jin-latest"), "osd-jin-latest should be present");
  assert.ok(ids.includes("osd-jin-movers"), "osd-jin-movers should be present");

  // osd endpoints point to osd-coral; JIN endpoints point to jin-orcin-pi
  const osdEps = solanaEndpoints.filter((e) => ["osd-ipo", "osd-holders", "osd-liquidity"].includes(e.id));
  for (const ep of osdEps) {
    assert.ok(ep.url.includes("osd-coral.vercel.app"), `${ep.id} must point to osd-coral`);
    assert.equal(ep.method, "GET");
    assert.equal(ep.cost, 0.01);
  }

  const jinEps = solanaEndpoints.filter((e) => e.id.startsWith("osd-jin-"));
  for (const ep of jinEps) {
    assert.ok(ep.url.includes("jin-orcin-pi.vercel.app"), `${ep.id} must point to jin-orcin-pi`);
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
  assert.equal(ENDPOINTS_MODE_B.length, 14, "Should have 9 Base + 5 Solana = 14 endpoints");
});
