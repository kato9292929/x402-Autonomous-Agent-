/**
 * One-shot: create the weekly external probe's payer wallet in Circle DCW.
 *
 * The probe pays third parties, so §5 keeps its funds separate from the
 * production payment wallet: a wrong price or a runaway loop can only reach what
 * is in this wallet. Circle holds the key; the deployment gets a wallet id and
 * an address, never a raw key.
 *
 * Base mainnet, so this uses the LIVE credentials (CIRCLE_API_KEY /
 * CIRCLE_ENTITY_SECRET). There is deliberately no fallback to the TEST pair.
 *
 * Run (egress required — Circle API):
 *   npm run build && node dist/scripts/circle-create-probe-wallet.js
 *
 * Required env:
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET
 * Optional:
 *   CIRCLE_WALLET_SET_ID — reuses the existing LIVE wallet set. When unset a new
 *     one is created and its id printed.
 */
import "dotenv/config";
import * as crypto from "node:crypto";
import { CIRCLE_API, getCircleCredentials, buildCiphertextFor } from "../circle/client";

/** Base mainnet, where the probe's USDC lives. */
const BLOCKCHAIN = "BASE";
const INITIAL_FUNDING_USDC = 20;

function fail(message: string, detail?: string): never {
  console.error(`\n[PROBE-WALLET] ${message}`);
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

async function resolveWalletSetId(apiKey: string, ciphertext: string): Promise<string> {
  const existing = process.env.CIRCLE_WALLET_SET_ID;
  if (existing) {
    console.log(`Using CIRCLE_WALLET_SET_ID=${existing}`);
    return existing;
  }

  console.log("CIRCLE_WALLET_SET_ID is unset — creating a LIVE wallet set...");
  const json = await post<{ data?: { walletSet?: { id?: string } } }>(
    "/developer/walletSets",
    apiKey,
    {
      idempotencyKey: crypto.randomUUID(),
      name: "aa-external-probe",
      entitySecretCiphertext: ciphertext,
    }
  );
  const id = json.data?.walletSet?.id;
  if (!id) fail("No walletSet id in the response", JSON.stringify(json));

  console.log("\n=== LIVE wallet set created ===");
  console.log(`CIRCLE_WALLET_SET_ID=${id}\n`);
  return id;
}

async function main(): Promise<void> {
  const creds = getCircleCredentials("live");

  // A fresh ciphertext per call: Circle rejects a reused entity secret ciphertext.
  const walletSetId = await resolveWalletSetId(creds.apiKey, await buildCiphertextFor(creds));

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

  console.log("\n=== External probe wallet created ===");
  console.log(`CIRCLE_PROBE_WALLET_ID=${wallet.id}`);
  console.log(`CIRCLE_PROBE_WALLET_ADDRESS=${wallet.address}`);
  console.log(`\nNext:`);
  console.log(`  1. Put both values into Railway Variables.`);
  console.log(`  2. Fund ${wallet.address} with $${INITIAL_FUNDING_USDC} Base USDC.`);
  console.log(`     残高ガードが自動でこのウォレットも監視する (閾値 BALANCE_WARN_PROBE_USDC, 既定 $5)。`);
  console.log(`  3. node dist/index.js --probe-run0  ← 無課金の discovery。到達性・402・単価を確認`);
  console.log(`  4. 確認できたら PROBE_ENABLED=true で週次 sweep を有効化`);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
