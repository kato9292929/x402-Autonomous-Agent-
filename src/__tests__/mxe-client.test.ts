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
import { circleMxeWallet } from "../mxe/wallet";

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
