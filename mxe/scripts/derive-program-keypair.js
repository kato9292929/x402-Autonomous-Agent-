/**
 * Derive the aa_mxe program keypair from the deploy key.
 *
 *   node scripts/derive-program-keypair.js <deploy-key.json> <out.json>
 *
 * The program id has to be stable across deploys — an upgrade targets the same
 * address, and the AA client points at it — but the source only commits a
 * localnet placeholder. Deriving the program keypair from the deploy key keeps
 * it stable without a second secret: whoever holds the deploy key can recreate
 * it, and nobody else can.
 *
 * Prints the program id. Writes a Solana CLI keypair file (64-byte JSON array).
 */
const { createHash } = require("crypto");
const { readFileSync, writeFileSync } = require("fs");
const { Keypair } = require("@solana/web3.js");

const [deployPath, outPath] = process.argv.slice(2);
if (!deployPath || !outPath) {
  console.error("usage: derive-program-keypair.js <deploy-key.json> <out.json>");
  process.exit(2);
}

const deploy = JSON.parse(readFileSync(deployPath, "utf8"));
if (!Array.isArray(deploy) || deploy.length !== 64) {
  console.error("deploy key must be a 64-byte JSON array (Solana CLI keypair)");
  process.exit(2);
}

// Domain-separated: the derived key is never the deploy key, and a future
// scheme can change the label without colliding with this one.
const seed = createHash("sha256")
  .update("aa-mxe/program-id/v1")
  .update(Buffer.from(deploy.slice(0, 32)))
  .digest();
const kp = Keypair.fromSeed(seed);

writeFileSync(outPath, JSON.stringify(Array.from(kp.secretKey)));
console.log(kp.publicKey.toBase58());
