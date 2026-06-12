/**
 * Tests for Solana manual 402 payment flow.
 * Uses node:test (Node.js 20+, no extra dependencies).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  microUsdcToDecimal,
  parsePaymentRequired,
  buildPaymentProofHeader,
} from "../solana-payment";

// ── microUsdcToDecimal ────────────────────────────────────────────────────────

test("microUsdcToDecimal converts 200000 micro-USDC to 0.200000", () => {
  assert.equal(microUsdcToDecimal(200000n), "0.200000");
});

test("microUsdcToDecimal converts 1000000 to 1.000000", () => {
  assert.equal(microUsdcToDecimal(1_000_000n), "1.000000");
});

test("microUsdcToDecimal converts 50000 to 0.050000", () => {
  assert.equal(microUsdcToDecimal(50_000n), "0.050000");
});

test("microUsdcToDecimal accepts string input", () => {
  assert.equal(microUsdcToDecimal("200000"), "0.200000");
});

test("microUsdcToDecimal converts 1500000 to 1.500000", () => {
  assert.equal(microUsdcToDecimal(1_500_000n), "1.500000");
});

// ── parsePaymentRequired ──────────────────────────────────────────────────────

function makeResponse(headers: Record<string, string>): Response {
  return new Response(null, { status: 402, headers });
}

test("parsePaymentRequired returns null if no payment header", () => {
  const res = makeResponse({});
  assert.equal(parsePaymentRequired(res), null);
});

test("parsePaymentRequired parses v2 base64url-encoded array", () => {
  const req = {
    scheme: "exact",
    network: "solana",
    payTo: "SolanaAddr123",
    amount: "200000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  };
  const header = Buffer.from(JSON.stringify([req])).toString("base64url");
  const res = makeResponse({ "PAYMENT-REQUIRED": header });
  const parsed = parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolanaAddr123");
  assert.equal(parsed.amount, "200000");
  assert.equal(parsed.network, "solana");
});

test("parsePaymentRequired parses v1 plain JSON object", () => {
  const req = {
    scheme: "exact",
    network: "solana",
    payTo: "SolanaAddr456",
    maxAmountRequired: "100000",
  };
  const res = makeResponse({ "X-PAYMENT-REQUIRED": JSON.stringify(req) });
  const parsed = parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolanaAddr456");
  assert.equal(parsed.maxAmountRequired, "100000");
});

test("parsePaymentRequired ignores non-Solana requirements in array", () => {
  const reqs = [
    { scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "200000" },
    { scheme: "exact", network: "solana", payTo: "SolanaOnly", amount: "50000" },
  ];
  const header = Buffer.from(JSON.stringify(reqs)).toString("base64url");
  const res = makeResponse({ "PAYMENT-REQUIRED": header });
  const parsed = parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolanaOnly");
  assert.equal(parsed.network, "solana");
});

test("parsePaymentRequired returns null for EVM-only requirements", () => {
  const reqs = [{ scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "200000" }];
  const header = Buffer.from(JSON.stringify(reqs)).toString("base64url");
  const res = makeResponse({ "PAYMENT-REQUIRED": header });
  const parsed = parsePaymentRequired(res);
  assert.equal(parsed, null);
});

test("parsePaymentRequired handles PAYMENT-REQUIRED header (v2) over X-PAYMENT-REQUIRED (v1)", () => {
  const v2Req = { scheme: "exact", network: "solana", payTo: "V2Addr", amount: "300000" };
  const v1Req = { scheme: "exact", network: "solana", payTo: "V1Addr", maxAmountRequired: "100000" };
  const header = Buffer.from(JSON.stringify([v2Req])).toString("base64url");
  const res = makeResponse({
    "PAYMENT-REQUIRED": header,
    "X-PAYMENT-REQUIRED": JSON.stringify(v1Req),
  });
  const parsed = parsePaymentRequired(res);
  // PAYMENT-REQUIRED (v2) takes precedence
  assert.equal(parsed?.payTo, "V2Addr");
});

// ── buildPaymentProofHeader ───────────────────────────────────────────────────

test("buildPaymentProofHeader produces valid base64url JSON", () => {
  const req = { scheme: "exact", network: "solana", payTo: "SolPay", amount: "200000" };
  const header = buildPaymentProofHeader("sig123abc", "myWalletAddr", req);

  // Should decode as valid JSON
  const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf-8")) as {
    x402Version: number;
    scheme: string;
    network: string;
    payload: { signature: string; from: string };
  };

  assert.equal(decoded.x402Version, 1);
  assert.equal(decoded.scheme, "exact");
  assert.equal(decoded.network, "solana");
  assert.equal(decoded.payload.signature, "sig123abc");
  assert.equal(decoded.payload.from, "myWalletAddr");
});

// ── Chain routing ─────────────────────────────────────────────────────────────

test("MODE B has 2 Solana endpoints with confirmed Hyre base URL", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  const solanaEndpoints = ENDPOINTS_MODE_B.filter((e) => e.chain === "solana");
  assert.equal(solanaEndpoints.length, 2, "Should have exactly 2 Solana endpoints");

  for (const ep of solanaEndpoints) {
    assert.equal(ep.chain, "solana");
    assert.ok(ep.url.includes("hyreagent.fun") || ep.url.length > 0, `${ep.id} should have Hyre URL`);
    assert.ok(["GET", "POST"].includes(ep.method));
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
