/**
 * One-shot: create the Base Sepolia payer wallet in Circle DCW.
 *
 * This is the buyer wallet for the testnet self-payment demo (T8–T9). Keeping it
 * in Circle means the Base Sepolia key never enters the deployment, the same
 * property the mainnet Base leg already has.
 *
 * Base Sepolia is a testnet, so this uses the TEST credentials — the same pair
 * the Arc scripts use. A LIVE key is rejected on testnet chains (Circle 156006),
 * and there is deliberately no fallback between the two.
 *
 * Run (egress required — Circle API):
 *   npm run build && node dist/scripts/circle-create-base-sepolia-wallet.js
 *
 * Required env:
 *   CIRCLE_API_KEY_TEST, CIRCLE_ENTITY_SECRET_TEST
 * Optional:
 *   CIRCLE_WALLET_SET_ID_TEST — reuses an existing TEST wallet set. When unset a
 *     new one is created and its id printed; save it to skip re-creating later.
 *
 * Prints the values to put into Railway Variables.
 */
import "dotenv/config";
import * as crypto from "node:crypto";
import { CIRCLE_API, getCircleCredentials, buildCiphertextFor } from "../circle/client";

/** Circle's identifier for Base Sepolia (confirmed in the installed SDK types). */
const BLOCKCHAIN = "BASE-SEPOLIA";
const FAUCET = "https://faucet.circle.com";

function fail(message: string, detail?: string): never {
  console.error(`\n[BASE-SEPOLIA] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

async function post<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(`${CIRCLE_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`Circle API error: HTTP ${res.status} (${path})`, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    fail(`Could not parse Circle response (${path})`, text);
  }
}

/** Reuse CIRCLE_WALLET_SET_ID_TEST, or create a TEST wallet set and report its id. */
async function resolveWalletSetId(apiKey: string, ciphertext: string): Promise<string> {
  const existing = process.env.CIRCLE_WALLET_SET_ID_TEST;
  if (existing) {
    console.log(`Using CIRCLE_WALLET_SET_ID_TEST=${existing}`);
    return existing;
  }

  console.log("CIRCLE_WALLET_SET_ID_TEST is unset — creating a TEST wallet set...");
  const json = await post<{ data?: { walletSet?: { id?: string } } }>(
    "/developer/walletSets",
    apiKey,
    {
      idempotencyKey: crypto.randomUUID(),
      name: "aa-base-sepolia",
      entitySecretCiphertext: ciphertext,
    }
  );
  const id = json.data?.walletSet?.id;
  if (!id) fail("No walletSet id in the response", JSON.stringify(json));

  console.log("\n=== TEST wallet set created ===");
  console.log(`CIRCLE_WALLET_SET_ID_TEST=${id}`);
  console.log("Save this to skip re-creating it next time.\n");
  return id;
}

async function main(): Promise<void> {
  // Throws with a clear message when the TEST credentials are missing.
  const creds = getCircleCredentials("test");

  // A fresh ciphertext per call: Circle rejects a reused entity secret ciphertext.
  const walletSetId = await resolveWalletSetId(
    creds.apiKey,
    await buildCiphertextFor(creds)
  );

  console.log(`Creating 1 ${BLOCKCHAIN} EOA wallet in wallet set ${walletSetId} ...`);
  const json = await post<{ data?: { wallets?: Array<{ id: string; address: string }> } }>(
    "/developer/wallets",
    creds.apiKey,
    {
      idempotencyKey: crypto.randomUUID(),
      entitySecretCiphertext: await buildCiphertextFor(creds),
      walletSetId,
      blockchains: [BLOCKCHAIN],
      // EOA: the x402 exact scheme signs an EIP-712 authorisation, so the payer
      // needs a plain externally-owned account, not a smart-contract account.
      accountType: "EOA",
      count: 1,
    }
  );

  const wallet = json.data?.wallets?.[0];
  if (!wallet) fail("No wallet in the response", JSON.stringify(json));

  console.log("\n=== Base Sepolia payer wallet created ===");
  console.log(`CIRCLE_BASE_SEPOLIA_WALLET_ID=${wallet.id}`);
  console.log(`CIRCLE_BASE_SEPOLIA_WALLET_ADDRESS=${wallet.address}`);
  console.log(`\nNext:`);
  console.log(`  1. Put both values into Railway Variables.`);
  console.log(`  2. Fund ${wallet.address} with Base Sepolia USDC: ${FAUCET}`);
  console.log(`  3. Set X402_TESTNET_ENABLED=true to register the eip155:84532 leg.`);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
