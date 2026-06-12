/**
 * Tests for Circle DCW utility functions.
 * Uses node:test (Node.js 20+, no extra dependencies).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { encryptEntitySecret } from "../circle/client";

// ── encryptEntitySecret ───────────────────────────────────────────────────────

test("encryptEntitySecret produces base64 string decryptable with corresponding private key", () => {
  // Generate a fresh RSA key pair for testing
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const entitySecretHex = crypto.randomBytes(32).toString("hex");

  const ciphertext = encryptEntitySecret(entitySecretHex, publicKeyPem);

  // Should be a non-empty base64 string
  assert.ok(typeof ciphertext === "string" && ciphertext.length > 0);

  // Should be decryptable
  const decrypted = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(ciphertext, "base64")
  );

  assert.equal(decrypted.toString("hex"), entitySecretHex);
});

test("encryptEntitySecret produces different ciphertexts for same input (OAEP randomness)", () => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const secret = crypto.randomBytes(32).toString("hex");

  const c1 = encryptEntitySecret(secret, pem);
  const c2 = encryptEntitySecret(secret, pem);

  // RSA-OAEP includes random padding, so ciphertexts should differ
  assert.notEqual(c1, c2);
});
