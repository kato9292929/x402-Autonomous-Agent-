/**
 * Tests for Solana endpoint configuration and chain routing.
 * Uses node:test (Node.js 20+, no extra dependencies).
 *
 * Solana payment logic is now handled by @x402/svm SDK (registerExactSvmScheme).
 * Manual solana-payment.ts has been removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("MODE B has 2 JIN Solana endpoints; the removed osd routes are gone", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  const solanaEndpoints = ENDPOINTS_MODE_B.filter((e) => e.chain === "solana");
  assert.equal(solanaEndpoints.length, 2, "Should have exactly 2 Solana endpoints");

  const ids = solanaEndpoints.map((e) => e.id);
  assert.ok(ids.includes("osd-jin-latest"), "osd-jin-latest should be present");
  assert.ok(ids.includes("osd-jin-movers"), "osd-jin-movers should be present");

  // /api/ipo, /api/holders and /api/liquidity were deliberately removed from osd
  // (PR #29) and 404 on the new domain, so the agent must not call them.
  for (const gone of ["osd-ipo", "osd-holders", "osd-liquidity"]) {
    assert.ok(!ids.includes(gone), `${gone} was deleted upstream and must not be called`);
  }

  // JIN prices come from the published catalog: latest is free, movers is $0.02.
  const jinCost: Record<string, number> = { "osd-jin-latest": 0, "osd-jin-movers": 0.02 };
  for (const ep of solanaEndpoints) {
    assert.ok(ep.url.includes("jin.x402jp.com"), `${ep.id} must point to jin.x402jp.com`);
    assert.equal(ep.method, "GET");
    assert.equal(ep.cost, jinCost[ep.id], `${ep.id} cost must match the published catalog`);
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

test("MODE B has 12 endpoints total", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  assert.equal(ENDPOINTS_MODE_B.length, 12, "Should have 10 Base + 2 JIN Solana = 12 endpoints");
});
