/**
 * Create a Circle wallet set + testnet wallets for the AA.
 *
 * Creates EOA wallets on Base Sepolia (EVM) and Solana Devnet so x402's
 * EIP-3009 gasless authorization works (the facilitator verifies a standard
 * EIP-712 signature from an externally-owned account).
 *
 * Usage:
 *   npm run circle:setup                 # testnet (BASE-SEPOLIA + SOL-DEVNET)
 *   CIRCLE_NETWORKS=BASE-SEPOLIA npm run circle:setup   # EVM only
 *
 * Prints the wallet ids + addresses to paste into .env:
 *   CIRCLE_EVM_WALLET_ID / CIRCLE_EVM_WALLET_ADDRESS
 *   CIRCLE_SOLANA_WALLET_ID / CIRCLE_SOLANA_WALLET_ADDRESS
 *
 * After creating wallets, fund the EVM address with testnet USDC from the
 * Circle faucet: https://faucet.circle.com  (Base Sepolia).
 */
import "dotenv/config";
import { getCircleClient } from "../circle/client";
import type { Blockchain } from "@circle-fin/developer-controlled-wallets";

function parseNetworks(): Blockchain[] {
  const raw = process.env.CIRCLE_NETWORKS ?? "BASE-SEPOLIA,SOL-DEVNET";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Blockchain[];
}

async function main(): Promise<void> {
  const client = getCircleClient();
  const networks = parseNetworks();
  const walletSetName =
    process.env.CIRCLE_WALLET_SET_NAME ?? "x402-autonomous-agent";

  console.log(`[circle:setup] Creating wallet set "${walletSetName}"...`);
  const walletSetRes = await client.createWalletSet({ name: walletSetName });
  const walletSetId = walletSetRes.data?.walletSet?.id;
  if (!walletSetId) {
    throw new Error("Failed to create wallet set: no id returned");
  }
  console.log(`[circle:setup] ✓ Wallet set id: ${walletSetId}`);

  console.log(
    `[circle:setup] Creating EOA wallets on: ${networks.join(", ")}...`
  );
  const walletsRes = await client.createWallets({
    walletSetId,
    blockchains: networks,
    accountType: "EOA",
    count: 1,
  });

  const wallets = walletsRes.data?.wallets ?? [];
  if (wallets.length === 0) {
    throw new Error("No wallets returned from createWallets");
  }

  console.log("\n========== Add these to your .env ==========\n");
  console.log(`# Circle wallet set`);
  console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
  for (const w of wallets) {
    const chain = String(w.blockchain);
    if (chain.startsWith("SOL")) {
      console.log(`\n# Solana (${chain})`);
      console.log(`CIRCLE_SOLANA_WALLET_ID=${w.id}`);
      console.log(`CIRCLE_SOLANA_WALLET_ADDRESS=${w.address}`);
    } else {
      console.log(`\n# EVM (${chain})`);
      console.log(`CIRCLE_EVM_WALLET_ID=${w.id}`);
      console.log(`CIRCLE_EVM_WALLET_ADDRESS=${w.address}`);
    }
  }
  console.log("\n============================================\n");
  console.log(
    "Next: fund the EVM address with Base Sepolia USDC at https://faucet.circle.com,"
  );
  console.log(
    "then set CIRCLE_ALLOWLIST to the x402 endpoints' payTo addresses and run `npm run circle:verify`."
  );
}

main().catch((err) => {
  console.error("[circle:setup] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
