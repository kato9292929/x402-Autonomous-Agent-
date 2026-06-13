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

function makeBodyResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeHeaderResponse(headers: Record<string, string>): Response {
  return new Response(null, { status: 402, headers });
}

// x402 v2 body-based (primary path — used by osd)
test("parsePaymentRequired parses x402 v2 body with Solana accepts", async () => {
  const res = makeBodyResponse({
    x402Version: 2,
    accepts: [
      { scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "200000" },
      { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "SolBody", amount: "10000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    ],
  });
  const parsed = await parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolBody");
  assert.equal(parsed.amount, "10000");
  assert.ok(parsed.network.includes("solana"));
});

test("parsePaymentRequired returns null for x402 v2 body with EVM-only accepts", async () => {
  const res = makeBodyResponse({
    x402Version: 2,
    accepts: [
      { scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "200000" },
    ],
  });
  const parsed = await parsePaymentRequired(res);
  assert.equal(parsed, null);
});

test("parsePaymentRequired returns null if no body and no header", async () => {
  const res = makeHeaderResponse({});
  assert.equal(await parsePaymentRequired(res), null);
});

// Header fallback (v1 / non-standard)
test("parsePaymentRequired falls back to PAYMENT-REQUIRED header (base64url array)", async () => {
  const req = {
    scheme: "exact",
    network: "solana",
    payTo: "SolanaAddr123",
    amount: "200000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  };
  const header = Buffer.from(JSON.stringify([req])).toString("base64url");
  const res = makeHeaderResponse({ "PAYMENT-REQUIRED": header });
  const parsed = await parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolanaAddr123");
  assert.equal(parsed.amount, "200000");
  assert.equal(parsed.network, "solana");
});

test("parsePaymentRequired falls back to X-PAYMENT-REQUIRED header (plain JSON)", async () => {
  const req = {
    scheme: "exact",
    network: "solana",
    payTo: "SolanaAddr456",
    maxAmountRequired: "100000",
  };
  const res = makeHeaderResponse({ "X-PAYMENT-REQUIRED": JSON.stringify(req) });
  const parsed = await parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolanaAddr456");
  assert.equal(parsed.maxAmountRequired, "100000");
});

test("parsePaymentRequired ignores non-Solana in header array fallback", async () => {
  const reqs = [
    { scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "200000" },
    { scheme: "exact", network: "solana", payTo: "SolanaOnly", amount: "50000" },
  ];
  const header = Buffer.from(JSON.stringify(reqs)).toString("base64url");
  const res = makeHeaderResponse({ "PAYMENT-REQUIRED": header });
  const parsed = await parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "SolanaOnly");
});

test("parsePaymentRequired returns null for EVM-only header array", async () => {
  const reqs = [{ scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "200000" }];
  const header = Buffer.from(JSON.stringify(reqs)).toString("base64url");
  const res = makeHeaderResponse({ "PAYMENT-REQUIRED": header });
  assert.equal(await parsePaymentRequired(res), null);
});

// osd actual format: header contains base64-encoded { x402Version:2, accepts:[...] }
test("parsePaymentRequired parses osd format: header with base64 { x402Version:2, accepts:[] }", async () => {
  const v2body = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: "https://osd-coral.vercel.app/api/ipo" },
    accepts: [
      { scheme: "exact", network: "eip155:8453", payTo: "0xEVM", amount: "10000" },
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "10000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: "4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf",
        extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP" },
      },
    ],
  };
  const header = Buffer.from(JSON.stringify(v2body)).toString("base64");
  const res = makeHeaderResponse({ "payment-required": header });
  const parsed = await parsePaymentRequired(res);
  assert.ok(parsed !== null);
  assert.equal(parsed.payTo, "4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf");
  assert.equal(parsed.amount, "10000");
  assert.ok(parsed.network.includes("solana"));
});

// ── buildPaymentProofHeader ───────────────────────────────────────────────────

test("buildPaymentProofHeader produces valid base64url JSON", () => {
  const req = { scheme: "exact", network: "solana", payTo: "SolPay", amount: "200000" };
  const header = buildPaymentProofHeader("sig123abc", "myWalletAddr", req);

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
