/**
 * Payment diagnostics script for @x402/fetch v2.
 * Run: node dist/test-payment.js
 */
import "dotenv/config";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const TARGET_URL =
  process.env.TEST_URL ??
  "https://x402yi.vercel.app/api/yield/scan"; // Yield Intelligence $0.20

async function diagnose(): Promise<void> {
  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    console.error("ERROR: PAYMENT_PRIVATE_KEY is not set");
    process.exit(1);
  }

  console.log("=== x402 v2 Payment Diagnostics ===");
  console.log(`Target URL: ${TARGET_URL}`);

  // ── Step 1: Build signer ────────────────────────────────────────
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const signer = toClientEvmSigner(account);
  console.log(`\n[1] Signer address: ${account.address}`);

  // ── Step 2: Build x402Client ────────────────────────────────────
  const evmScheme = new ExactEvmScheme(signer);
  const client = new x402Client()
    .register("eip155:8453", evmScheme)  // v2
    .registerV1("base", evmScheme);       // v1 compat

  console.log(`\n[2] x402Client built with eip155:8453 (v2) + base (v1)`);

  // ── Step 3: Initial request ─────────────────────────────────────
  console.log("\n[3] Sending initial request (expect 402)...");
  const firstRes = await fetch(TARGET_URL);
  console.log(`    status: ${firstRes.status}`);
  const firstBody = await firstRes.text();
  console.log(`    body (first 300 chars): ${firstBody.slice(0, 300)}`);

  const paymentRequiredHeader = firstRes.headers.get("PAYMENT-REQUIRED");
  console.log(`    PAYMENT-REQUIRED header: ${paymentRequiredHeader ? paymentRequiredHeader.slice(0, 80) + "..." : "(none)"}`);

  if (firstRes.status !== 402) {
    console.warn("    WARNING: did not get 402 — stopping");
    return;
  }

  // ── Step 4: Full payment flow ───────────────────────────────────
  console.log("\n[4] Running full wrapFetchWithPayment call...");
  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  let secondRes: Response;
  try {
    secondRes = await fetchWithPay(TARGET_URL);
  } catch (err) {
    console.error(`    fetchWithPayment threw: ${err}`);
    return;
  }

  console.log(`    second response status: ${secondRes.status}`);
  const paymentResponseHeader =
    secondRes.headers.get("PAYMENT-RESPONSE") ?? secondRes.headers.get("X-PAYMENT-RESPONSE");
  console.log(`    PAYMENT-RESPONSE header: ${paymentResponseHeader ? paymentResponseHeader.slice(0, 60) + "..." : "(none)"}`);

  const secondBody = await secondRes.text();
  console.log(`    body (first 400 chars):\n${secondBody.slice(0, 400)}`);

  if (!secondRes.ok) {
    console.error(`\n  ✗ Payment FAILED (HTTP ${secondRes.status})`);
    return;
  }

  // ── Step 5: Decode txHash ───────────────────────────────────────
  if (paymentResponseHeader) {
    try {
      const decoded = decodePaymentResponseHeader(paymentResponseHeader);
      console.log(`\n[5] txHash: ${decoded.transaction}`);
    } catch (err) {
      console.warn(`    decodePaymentResponseHeader error: ${err}`);
    }
  }

  console.log("\n  ✓ Payment SUCCESS");
}

diagnose().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
