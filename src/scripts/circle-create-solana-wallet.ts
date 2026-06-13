/**
 * One-shot script: create a Solana (SOL) EOA wallet in the existing Circle wallet set.
 *
 * Run via Railway Custom Start Command:
 *   node dist/scripts/circle-create-solana-wallet.js
 *
 * Required env vars:
 *   CIRCLE_API_KEY        — Circle API key (already in Railway)
 *   CIRCLE_WALLET_SET_ID  — Wallet set ID shared with the Base wallet
 *
 * Output (copy these into Railway Variables):
 *   CIRCLE_SOLANA_WALLET_ID=<id>
 *   SOLANA_WALLET_ADDRESS=<address>
 */
import * as crypto from "node:crypto";
import { CIRCLE_API, buildEntitySecretCiphertext, getRequiredApiKey } from "../circle/client";

async function main(): Promise<void> {
  const apiKey = getRequiredApiKey();

  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!walletSetId) {
    console.error("ERROR: CIRCLE_WALLET_SET_ID is not set");
    process.exit(1);
  }

  const idempotencyKey = crypto.randomUUID();
  const entitySecretCiphertext = await buildEntitySecretCiphertext(apiKey);

  console.log(`Creating Solana EOA wallet in wallet set ${walletSetId} ...`);

  const res = await fetch(`${CIRCLE_API}/developer/wallets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      idempotencyKey,
      entitySecretCiphertext,
      walletSetId,
      blockchains: ["SOL"],
      accountType: "EOA",
      count: 1,
    }),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error(`Circle API error: HTTP ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  let json: { data: { wallets: Array<{ id: string; address: string }> } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    console.error("Failed to parse Circle API response:");
    console.error(text);
    process.exit(1);
  }

  const wallet = json.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) {
    console.error("Unexpected response shape — no wallet returned:");
    console.error(text);
    process.exit(1);
  }

  console.log("\n=== Solana wallet created successfully ===");
  console.log(`CIRCLE_SOLANA_WALLET_ID=${wallet.id}`);
  console.log(`SOLANA_WALLET_ADDRESS=${wallet.address}`);
  console.log("\nAdd both values to Railway Variables, then restore Custom Start Command to:");
  console.log("  node dist/index.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
