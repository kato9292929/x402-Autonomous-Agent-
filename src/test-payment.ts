/**
 * Payment diagnostics script.
 * Run: node dist/test-payment.js
 *
 * Prints every step of the x402 flow for one endpoint so failures are visible.
 */
import "dotenv/config";
import { createSigner } from "x402-fetch";
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

  console.log("=== x402 Payment Diagnostics ===");
  console.log(`Target URL: ${TARGET_URL}`);

  // ── Step 1: LocalAccount address ──────────────────────────────
  const localAccount = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`\n[1] LocalAccount address: ${localAccount.address}`);

  // ── Step 2: createSigner (x402 official) ──────────────────────
  console.log("\n[2] Creating signer via createSigner('base', key)...");
  let signer: Awaited<ReturnType<typeof createSigner>>;
  try {
    signer = await createSigner("base", privateKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = signer as any;
    console.log(`    signer type: ${typeof s}`);
    console.log(`    signer.chain: ${JSON.stringify(s?.chain?.name ?? s?.chain?.id ?? "(no chain)")}`);
    console.log(`    signer.account?.address: ${s?.account?.address ?? s?.address ?? "(no address)"}`);
  } catch (err) {
    console.error(`    createSigner failed: ${err}`);
    process.exit(1);
  }

  // ── Step 3: Send initial request → expect 402 ─────────────────
  console.log("\n[3] Sending initial request (expect 402)...");
  const firstRes = await fetch(TARGET_URL);
  console.log(`    status: ${firstRes.status}`);
  const firstBody = await firstRes.text();
  console.log(`    body (raw): ${firstBody.slice(0, 300)}`);

  if (firstRes.status !== 402) {
    console.warn("    WARNING: did not get 402, stopping");
    return;
  }

  // ── Step 4: Parse 402 challenge ───────────────────────────────
  console.log("\n[4] Parsing 402 challenge...");
  let challenge: { x402Version: number; accepts: unknown[] };
  try {
    challenge = JSON.parse(firstBody);
    console.log(`    x402Version: ${challenge.x402Version}`);
    console.log(`    accepts (count): ${challenge.accepts?.length}`);
    console.log(`    accepts[0]: ${JSON.stringify(challenge.accepts?.[0], null, 2)}`);
  } catch (err) {
    console.error(`    JSON parse error: ${err}`);
    console.error(`    Raw body was: ${JSON.stringify(firstBody.slice(0, 200))}`);
    return;
  }

  // ── Step 5: Build payment header manually ─────────────────────
  console.log("\n[5] Building payment header via createSigner flow...");
  const { wrapFetchWithPayment } = await import("x402-fetch");
  const fetchWithPayment = wrapFetchWithPayment(fetch, signer, BigInt(3_000_000));

  // ── Step 6: Full x402 fetch (402 → sign → retry) ──────────────
  console.log("\n[6] Full fetchWithPayment call...");
  let secondRes: Response;
  try {
    secondRes = await fetchWithPayment(TARGET_URL);
  } catch (err) {
    console.error(`    fetchWithPayment threw: ${err}`);
    return;
  }

  console.log(`    second response status: ${secondRes.status}`);
  const xPayment = secondRes.headers.get("X-PAYMENT-RESPONSE");
  console.log(`    X-PAYMENT-RESPONSE header: ${xPayment ?? "(none)"}`);

  const secondBody = await secondRes.text();
  console.log(`    body (raw, first 400 chars):\n    ${secondBody.slice(0, 400)}`);

  if (!secondRes.ok) {
    console.error(`\n  ✗ Payment FAILED (HTTP ${secondRes.status})`);
    return;
  }

  // ── Step 7: Decode txHash ─────────────────────────────────────
  if (xPayment) {
    try {
      const { decodeXPaymentResponse } = await import("x402-fetch");
      const decoded = decodeXPaymentResponse(xPayment);
      console.log(`\n[7] txHash: ${decoded.transaction}`);
    } catch (err) {
      console.warn(`    decodeXPaymentResponse error: ${err}`);
    }
  }

  console.log("\n  ✓ Payment SUCCESS");
}

diagnose().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
