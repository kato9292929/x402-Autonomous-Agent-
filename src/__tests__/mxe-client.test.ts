/**
 * Pure parts of the MXE client: the plain search (function 5's comparison
 * side), mask decoding, the committed IDL, and the Circle wallet adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { maskToIndices, plainSearch, type CatalogEntry } from "../mxe/functions";
import { loadIdl } from "../mxe/chain";
import { circleMxeWallet, devnetQueuerFromEnv, keypairMxeWallet } from "../mxe/wallet";
import { hydrateAgentWallets } from "../mxe/wallets";

test("plain search applies category, any-format and max price like the circuit", () => {
  const cat: CatalogEntry[] = [
    { category: 3, format: 1, priceMicro: 1000 },
    { category: 3, format: 2, priceMicro: 6000 },
    { category: 2, format: 1, priceMicro: 100 },
    { category: 3, format: 2, priceMicro: 5000 },
  ];
  assert.deepEqual(plainSearch(cat, { category: 3, format: 0, maxPriceMicro: 5000 }), [0, 3]);
  assert.deepEqual(plainSearch(cat, { category: 3, format: 2, maxPriceMicro: 9999 }), [1, 3]);
});

test("mask bits map to catalog indices", () => {
  assert.deepEqual(maskToIndices(0b1001n, 8), [0, 3]);
  assert.deepEqual(maskToIndices(1n << 63n, 64), [63]);
  assert.deepEqual(maskToIndices(0n, 8), []);
});

test("committed IDL has every queue instruction the client calls", () => {
  const idl = loadIdl(PublicKey.default);
  const names = new Set(idl.instructions.map((i) => i.name));
  for (const n of [
    "seal_floor", "match_ceiling", "create_rfq", "place_quote", "close_rfq", "award_rfq",
    "create_scoreboard", "submit_rating", "reveal_scores", "joint_purchase", "set_catalog",
    "search_catalog_8", "search_catalog_16", "search_catalog_32", "search_catalog_64",
  ]) {
    assert.ok(names.has(n), n);
  }
  const jp = idl.instructions.find((i) => i.name === "joint_purchase")!;
  assert.equal(JSON.stringify(jp.args.at(-1)), JSON.stringify({ name: "price", type: "u32" }));
  assert.equal(idl.address, PublicKey.default.toBase58());
});

test("Circle wallet adapter attaches a valid signature for the fee payer", async () => {
  const kp = Keypair.generate();
  // Stand-in for Circle: signs the message bytes and answers base58, as Circle does.
  const client = {
    async signTransaction(input: { walletId: string; rawTransaction: string }) {
      const tx = Transaction.from(Buffer.from(input.rawTransaction, "base64"));
      tx.partialSign(kp);
      return { data: { signature: base58.encode(tx.signature!) } };
    },
  };
  const w = circleMxeWallet(client, "wallet-1", kp.publicKey.toBase58());
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })
  );
  const signed = await w.signTransaction(tx);
  assert.equal(signed.verifySignatures(), true);
});

test("a devnet keypair replaces the Circle TEST signer", async () => {
  const kp = Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey));
  const q = devnetQueuerFromEnv({ MXE_DEVNET_KEYPAIR: json });
  assert.ok(!("missing" in q));
  if ("missing" in q) return;
  assert.equal(q.address, kp.publicKey.toBase58());
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })
  );
  assert.equal((await q.wallet.signTransaction(tx)).verifySignatures(), true);
  assert.throws(() => keypairMxeWallet("/tmp/key.json"), /not JSON .*not its path/);
  assert.throws(() => keypairMxeWallet("[1,2,3]"), /64 numbers/);
  // With it set, the Circle TEST wallet is not looked up at all.
  const notes = await hydrateAgentWallets({ MXE_DEVNET_KEYPAIR: json }, {});
  assert.ok(notes.includes("aa-mxe-devnet-queuer: MXE_DEVNET_KEYPAIR"));
});

test("USDC ATA derivation matches a known mainnet account", async () => {
  const { usdcAta, createUsdcAtaIx, ATA_PROGRAM_ID } = await import("../mxe/usdc-accounts");
  // 6JKV…vEzA's USDC account, read from mainnet on 10/22.
  const owner = new PublicKey("6JKVugbVRXR92sacDzgxBU6k6Mb9AAhxLbEy3DyWvEzA");
  assert.equal(usdcAta(owner).toBase58(), "6tEoYiqMaNmdfpowpQJotd7y1a1b9xGkiB9D8CBArwbK");
  const ix = createUsdcAtaIx(Keypair.generate().publicKey, owner);
  assert.ok(ix.programId.equals(ATA_PROGRAM_ID));
  assert.deepEqual([...ix.data], [1], "CreateIdempotent");
  assert.ok(ix.keys[1].pubkey.equals(usdcAta(owner)));
});
