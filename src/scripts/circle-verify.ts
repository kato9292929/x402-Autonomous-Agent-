/**
 * Verify the Circle Wallets x402 integration on testnet.
 *
 *   npm run circle:verify
 *
 * What it checks:
 *   1. Config — Circle client builds, EVM signer resolves its address.
 *   2. Spending controls — feeds synthetic payment requirements through the
 *      policy to prove per-tx, daily, and allowlist limits all reject correctly
 *      (offline; no network needed).
 *   3. Live payment — if TEST_URL is set, runs a real x402 payment through the
 *      Circle-backed signer and reports the settled tx hash. Point it at a Base
 *      Sepolia x402 endpoint; fund the wallet via https://faucet.circle.com.
 */
import "dotenv/config";
import { decodePaymentResponseHeader } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/core/types";
import { initX402Fetch, fetchWithPayment, getSpendingControls } from "../x402";
import { createCircleEvmSigner } from "../circle/evm-signer";
import { SpendingControls } from "../circle/spending-controls";

function reqs(amountUsd: number, payTo: string): PaymentRequirements[] {
  return [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
      amount: String(Math.round(amountUsd * 1_000_000)),
      payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ];
}

function checkSpendingControls(): void {
  console.log("\n[2] Spending controls self-test (offline)");
  const allowed = "0x000000000000000000000000000000000000aaaa";
  const blocked = "0x000000000000000000000000000000000000bbbb";

  const sc = new SpendingControls({
    perTxLimitUsd: 5,
    dailyLimitUsd: 20,
    allowlist: [allowed],
    stateFile: "/tmp/circle-verify-spend-state.json",
  });

  const ok = sc.policy(2, reqs(1, allowed));
  console.log(`    within limits + allowlisted → ${ok.length === 1 ? "ACCEPT ✓" : "REJECT ✗ (unexpected)"}`);

  const overTx = sc.policy(2, reqs(6, allowed));
  console.log(`    over per-tx limit ($6 > $5)  → ${overTx.length === 0 ? "REJECT ✓" : "ACCEPT ✗ (unexpected)"}`);

  const notAllowed = sc.policy(2, reqs(1, blocked));
  console.log(`    recipient not on allowlist   → ${notAllowed.length === 0 ? "REJECT ✓" : "ACCEPT ✗ (unexpected)"}`);

  // Daily limit: simulate $19 already spent today, then a $2 request.
  const sc2 = new SpendingControls({
    perTxLimitUsd: 5,
    dailyLimitUsd: 20,
    allowlist: [allowed],
    stateFile: "/tmp/circle-verify-daily-state.json",
  });
  sc2.record(19);
  const overDaily = sc2.policy(2, reqs(2, allowed));
  console.log(`    over daily budget ($19+$2>$20)→ ${overDaily.length === 0 ? "REJECT ✓" : "ACCEPT ✗ (unexpected)"}`);
}

async function main(): Promise<void> {
  console.log("=== Circle Wallets × x402 verification ===");

  console.log("\n[1] Config");
  const signer = createCircleEvmSigner();
  console.log(`    Circle EVM signer address: ${signer.address}`);

  checkSpendingControls();

  await initX402Fetch();
  console.log(`\n[3] Active spending controls: ${getSpendingControls().summary()}`);

  const targetUrl = process.env.TEST_URL;
  if (!targetUrl) {
    console.log(
      "\n[3] No TEST_URL set — skipping live payment. Set TEST_URL to a Base " +
        "Sepolia x402 endpoint to run an end-to-end payment."
    );
    console.log("\n✓ Verification (config + spending controls) complete.");
    return;
  }

  console.log(`\n[4] Live payment → ${targetUrl}`);
  const res = await fetchWithPayment(targetUrl);
  console.log(`    status: ${res.status}`);
  const header =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (res.ok && header) {
    try {
      const decoded = decodePaymentResponseHeader(header);
      console.log(`    ✓ Paid via Circle wallet. tx: ${decoded.transaction}`);
    } catch {
      console.log("    ✓ Paid (PAYMENT-RESPONSE header present, unparseable)");
    }
  } else if (res.ok) {
    console.log("    ✓ 200 OK (no payment header — endpoint may be free)");
  } else {
    console.log(`    ✗ Payment did not complete (HTTP ${res.status})`);
    console.log(`    body: ${(await res.text()).slice(0, 300)}`);
  }
}

main().catch((err) => {
  console.error("[circle:verify] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
