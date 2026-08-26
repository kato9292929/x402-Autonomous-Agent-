/**
 * Circle Developer-Controlled Wallets — shared API client.
 * Handles entity secret RSA-OAEP encryption and Circle public key caching.
 * Used by both EVM signer and Solana transfer modules.
 */
import * as crypto from "node:crypto";

export const CIRCLE_API = "https://api.circle.com/v1/w3s";

/**
 * Circle's entity public key, cached per API key.
 *
 * This used to be a single unkeyed slot, which was safe only because the TEST
 * (Arc) scripts ran as separate one-off processes. Once a testnet signer shares
 * a process with the LIVE mainnet one, an unkeyed cache hands the second caller
 * the first caller's key and the entity secret gets encrypted for the wrong
 * environment. Keying by API key keeps the two apart.
 */
const _publicKeyByApiKey = new Map<string, string>();

export function encryptEntitySecret(entitySecretHex: string, publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const buf = Buffer.from(entitySecretHex, "hex");
  // RSA-OAEP includes random padding — each call produces a unique ciphertext (replay prevention)
  return crypto
    .publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      buf
    )
    .toString("base64");
}

export async function fetchCirclePublicKey(apiKey: string): Promise<string> {
  const cached = _publicKeyByApiKey.get(apiKey);
  if (cached) return cached;
  const res = await fetch(`${CIRCLE_API}/config/entity/publicKey`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[CIRCLE] publicKey fetch failed: HTTP ${res.status} — ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as { data: { publicKey: string } };
  _publicKeyByApiKey.set(apiKey, json.data.publicKey);
  return json.data.publicKey;
}

/**
 * Which Circle environment a signer talks to. Circle rejects testnet chains on
 * a LIVE key (156006) and vice versa, so this is never inferred — the caller
 * states it, and neither side falls back to the other.
 */
export type CircleEnv = "live" | "test";

export interface CircleCredentials {
  apiKey: string;
  entitySecret: string;
  env: CircleEnv;
}

export function getCircleCredentials(env: CircleEnv): CircleCredentials {
  if (env === "test") {
    const apiKey = process.env.CIRCLE_API_KEY_TEST;
    const entitySecret = process.env.CIRCLE_ENTITY_SECRET_TEST;
    if (!apiKey || !entitySecret) {
      throw new Error(
        "CIRCLE_API_KEY_TEST and CIRCLE_ENTITY_SECRET_TEST are required for testnet chains. " +
          "The LIVE credentials are not used as a fallback (Circle returns 156006 on testnet)."
      );
    }
    return { apiKey, entitySecret, env };
  }
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are required");
  }
  return { apiKey, entitySecret, env };
}

/** Encrypt the entity secret belonging to the given credentials. */
export async function buildCiphertextFor(creds: CircleCredentials): Promise<string> {
  const pubKey = await fetchCirclePublicKey(creds.apiKey);
  return encryptEntitySecret(creds.entitySecret, pubKey);
}

export async function buildEntitySecretCiphertext(apiKey: string): Promise<string> {
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET is required");
  const pubKey = await fetchCirclePublicKey(apiKey);
  return encryptEntitySecret(entitySecret, pubKey);
}

export function getRequiredApiKey(): string {
  const k = process.env.CIRCLE_API_KEY;
  if (!k) throw new Error("CIRCLE_API_KEY is required");
  return k;
}
