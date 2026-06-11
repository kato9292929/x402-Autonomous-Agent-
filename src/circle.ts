/**
 * Circle Developer-Controlled Wallets API client for Solana USDC transfers.
 * Handles entity secret encryption and transaction polling.
 */
import * as crypto from "node:crypto";

const CIRCLE_API = "https://api.circle.com/v1/w3s";
const USDC_MINT_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let _cachedPublicKey: string | null = null;

export function encryptEntitySecret(entitySecretHex: string, publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const buf = Buffer.from(entitySecretHex, "hex");
  return crypto
    .publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      buf
    )
    .toString("base64");
}

async function fetchCirclePublicKey(apiKey: string): Promise<string> {
  if (_cachedPublicKey) return _cachedPublicKey;
  const res = await fetch(`${CIRCLE_API}/config/entity/publicKey`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[CIRCLE] publicKey fetch failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data: { publicKey: string } };
  _cachedPublicKey = json.data.publicKey;
  return _cachedPublicKey;
}

async function buildEntitySecretCiphertext(apiKey: string): Promise<string> {
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET is required");
  const pubKey = await fetchCirclePublicKey(apiKey);
  return encryptEntitySecret(entitySecret, pubKey);
}

export interface CircleTransferParams {
  walletId: string;
  destinationAddress: string;
  amountDecimal: string; // e.g. "0.200000" for 0.20 USDC
}

export interface CircleTransferResult {
  transactionId: string;
}

export async function createCircleTransfer(
  params: CircleTransferParams
): Promise<CircleTransferResult> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY is required for Solana payments");

  const entitySecretCiphertext = await buildEntitySecretCiphertext(apiKey);
  const idempotencyKey = crypto.randomUUID();

  console.log(
    `[CIRCLE] Transfer ${params.amountDecimal} USDC → ${params.destinationAddress} (idempotency: ${idempotencyKey})`
  );

  const res = await fetch(`${CIRCLE_API}/developer/transactions/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      idempotencyKey,
      walletId: params.walletId,
      tokenAddress: USDC_MINT_SOLANA,
      destinationAddress: params.destinationAddress,
      amounts: [params.amountDecimal],
      blockchain: "SOL",
      feeLevel: "MEDIUM",
      entitySecretCiphertext,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`[CIRCLE] transfer failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { data: { transaction: { id: string } } };
  const transactionId = json.data?.transaction?.id;
  if (!transactionId) {
    throw new Error("[CIRCLE] transfer: no transactionId in response");
  }

  console.log(`[CIRCLE] Transfer submitted: ${transactionId}`);
  return { transactionId };
}

export async function waitForTransactionSignature(
  transactionId: string,
  maxWaitMs = 90_000,
  pollIntervalMs = 2_500
): Promise<string> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY is required");

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${CIRCLE_API}/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (res.ok) {
      const json = (await res.json()) as {
        data: { transaction: { state: string; txHash?: string } };
      };
      const tx = json.data?.transaction;

      if (tx?.state === "CONFIRMED" || tx?.state === "COMPLETE") {
        if (!tx.txHash) throw new Error("[CIRCLE] transaction confirmed but no txHash");
        console.log(`[CIRCLE] Transaction confirmed: ${tx.txHash}`);
        return tx.txHash;
      }

      if (tx?.state === "FAILED" || tx?.state === "DENIED") {
        throw new Error(`[CIRCLE] transaction ${tx.state}: ${transactionId}`);
      }

      // INITIATED / SENT — keep polling
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`[CIRCLE] transaction timeout after ${maxWaitMs}ms: ${transactionId}`);
}
