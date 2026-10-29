/**
 * Submit one rating to the AA's function 3 intake, sealed on this machine.
 *
 *   npm run build && npm run mxe:rate -- --url https://<aa-host> --slot 0 \
 *     --delivered 1 --format-ok 1 --latency 1200
 *
 * Reads the MXE key and field order from /api/mxe/ratings/info, encrypts with a
 * fresh x25519 key, and posts only ciphertext. The AA relays it; it cannot
 * read it. The secret key is never stored.
 */
import { randomBytes } from "crypto";
import { RescueCipher, x25519 } from "@arcium-hq/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function ratingPlaintext(slot: number, delivered: boolean, formatOk: boolean, latencyMs: number): bigint[] {
  if (!Number.isInteger(slot) || slot < 0 || slot > 7) throw new Error("--slot must be 0..7");
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error("--latency must be a non-negative number of ms");
  return [BigInt(slot), delivered ? 1n : 0n, formatOk ? 1n : 0n, BigInt(Math.round(latencyMs))];
}

async function main(): Promise<void> {
  const base = (arg("url") ?? "").replace(/\/$/, "");
  if (!base) throw new Error("--url is required (the AA's public origin)");
  const plain = ratingPlaintext(
    Number(arg("slot")),
    arg("delivered") === "1",
    arg("format-ok") === "1",
    Number(arg("latency") ?? 0)
  );

  const info = (await (await fetch(`${base}/api/mxe/ratings/info`)).json()) as {
    accepting: boolean;
    mxeX25519PublicKey: string | null;
    slots: string[];
  };
  if (!info.accepting || !info.mxeX25519PublicKey) throw new Error("the intake is not accepting ratings right now");
  console.log(`rating slot ${plain[0]} (${info.slots[Number(plain[0])]})`);

  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const cipher = new RescueCipher(x25519.getSharedSecret(sk, Uint8Array.from(Buffer.from(info.mxeX25519PublicKey, "hex"))));
  const nonce = randomBytes(16);
  const cts = cipher.encrypt(plain, nonce);

  const res = await fetch(`${base}/api/mxe/ratings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ciphertexts: cts.map((c) => Buffer.from(c).toString("hex")),
      evaluatorPublicKey: Buffer.from(pk).toString("hex"),
      nonce: nonce.toString("hex"),
    }),
  });
  console.log(res.status, await res.text());
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
