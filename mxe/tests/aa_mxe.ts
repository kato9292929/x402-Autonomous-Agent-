/**
 * AA × Arcium MXE — localnet tests for functions 1 and 2.
 *
 * Function 1 (reservation-price matching):
 *   seal_floor → match_ceiling. Checks the overlap case (midpoint revealed,
 *   including an odd sum so the overflow-free average's rounding is exercised)
 *   and the no-overlap case (nothing revealed beyond "no deal").
 *
 * Function 2 (sealed-quote RFQ):
 *   create_rfq → place_quote × 3 → close_rfq → award_rfq. Checks that the
 *   lowest quote's seller wins at its own price, and that nothing else is
 *   returned.
 *
 * Function 3 (seller scores): open → 3 ratings (two for one seller, one with
 *   a latency over the cap) → reveal. Checks the per-seller aggregates and the
 *   clamp, and that untouched slots stay zero.
 *
 * Function 4 (joint purchase): caps [600, 0, 900] for a price of 1000 → reached,
 *   shares 400 / 0 / 600 each decrypted by its own buyer; caps [100, 100, 100]
 *   → not reached, every share 0.
 *
 * Function 5 (endpoint search): the same query against catalogs of 8, 16, 32
 *   and 64 entries; the decrypted bitmask must equal a plain JS filter of the
 *   same catalog. Latency per size is what the cost curve is built from.
 *
 * Each queue → finalization round trip is timed and printed: that is the first
 * latency figure the integration records, taken on localnet.
 *
 * Helpers follow arcium-hq/examples `sealed_bid_auction` (ISC).
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { AaMxe } from "../target/types/aa_mxe";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  getArciumProgram,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

/** Little-endian lo/hi u128 halves, matching SerializedSolanaPublicKey. */
function splitPubkeyToU128s(pubkey: Uint8Array): { lo: bigint; hi: bigint } {
  return {
    lo: deserializeLE(pubkey.slice(0, 16)),
    hi: deserializeLE(pubkey.slice(16, 32)),
  };
}

const CIRCUITS = [
  "seal_floor",
  "match_ceiling",
  "open_rfq_state",
  "place_quote",
  "award_rfq",
  "open_scoreboard",
  "submit_rating",
  "reveal_scores",
  "joint_purchase",
  "search_catalog_8",
  "search_catalog_16",
  "search_catalog_32",
  "search_catalog_64",
] as const;

describe("AaMxe", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.AaMxe as Program<AaMxe>;
  const provider = anchor.getProvider();

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;

  /** Resolves on the first `eventName` whose `keyField` equals `key`. */
  const awaitEvent = async <E extends keyof Event>(
    eventName: E,
    keyField: string,
    key: PublicKey,
    timeoutMs = 120000
  ): Promise<Event[E]> => {
    let listenerId: number;
    let timeoutId: NodeJS.Timeout;
    const event = await new Promise<Event[E]>((res, rej) => {
      listenerId = program.addEventListener(
        eventName,
        (ev: Record<string, unknown>) => {
          const v = ev[keyField];
          if (v instanceof PublicKey && !v.equals(key)) return;
          clearTimeout(timeoutId);
          res(ev as Event[E]);
        }
      );
      timeoutId = setTimeout(() => {
        program.removeEventListener(listenerId);
        rej(new Error(`Event ${String(eventName)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  /** Accounts every queue instruction shares, for one circuit and offset. */
  const queueAccounts = (circuit: string, computationOffset: anchor.BN) => ({
    computationAccount: getComputationAccAddress(
      arciumEnv.arciumClusterOffset,
      computationOffset
    ),
    clusterAccount,
    mxeAccount: getMXEAccAddress(program.programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
    ),
  });

  /** Waits for MPC to finish and returns how long queue → finalize took. */
  const finalize = async (offset: anchor.BN, startedAt: number, label: string) => {
    const sig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      offset,
      program.programId,
      "confirmed"
    );
    const ms = Date.now() - startedAt;
    console.log(`   [latency] ${label}: ${ms} ms (finalize ${sig})`);
    return ms;
  };

  /** A fresh x25519 keypair and the Rescue cipher it shares with the MXE. */
  const newCipher = () => {
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const cipher = new RescueCipher(x25519.getSharedSecret(privateKey, mxePublicKey));
    return { publicKey, cipher };
  };

  const nonceArg = (nonce: Buffer) => new anchor.BN(deserializeLE(nonce).toString());
  const newOffset = () => new anchor.BN(randomBytes(8), "hex");
  // PDA ids are random rather than 1, 2, 3: the same suite runs against devnet
  // (`arcium test --cluster devnet`), where accounts from an earlier run persist.
  const newId = () => new anchor.BN(randomBytes(6), "hex").toNumber();

  let owner: anchor.web3.Keypair;
  let mxePublicKey: Uint8Array;

  before(async () => {
    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );
    console.log("MXE x25519 pubkey is", Buffer.from(mxePublicKey).toString("hex"));

    // Comp defs must exist before any computation can be queued.
    for (const circuit of CIRCUITS) {
      console.log(`Initializing ${circuit} comp def...`);
      await initCompDef(program, owner, circuit);
    }
  });

  // ── Function 1 ──────────────────────────────────────────────────────────

  /** Seals `floor` for negotiation `id`, then matches `ceiling` against it. */
  async function negotiate(id: number, floor: bigint, ceiling: bigint) {
    const [negotiationPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("negotiation"),
        owner.publicKey.toBuffer(),
        new anchor.BN(id).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Seller side: its own key, its own cipher.
    const seller = newCipher();
    const sealNonce = randomBytes(16);
    const [floorCt] = seller.cipher.encrypt([floor], sealNonce);
    const sealOffset = newOffset();
    const sealed = awaitEvent("floorSealedEvent", "negotiation", negotiationPDA);
    let t = Date.now();
    await program.methods
      .sealFloor(
        sealOffset,
        new anchor.BN(id),
        Array.from(floorCt),
        Array.from(seller.publicKey),
        nonceArg(sealNonce)
      )
      .accountsPartial({
        authority: owner.publicKey,
        negotiation: negotiationPDA,
        ...queueAccounts("seal_floor", sealOffset),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(sealOffset, t, `seal_floor #${id}`);
    await sealed;

    // Buyer side: a different key. Neither side sees the other's value.
    const buyer = newCipher();
    const matchNonce = randomBytes(16);
    const [ceilingCt] = buyer.cipher.encrypt([ceiling], matchNonce);
    const matchOffset = newOffset();
    const settled = awaitEvent("negotiationSettledEvent", "negotiation", negotiationPDA);
    t = Date.now();
    await program.methods
      .matchCeiling(
        matchOffset,
        Array.from(ceilingCt),
        Array.from(buyer.publicKey),
        nonceArg(matchNonce)
      )
      .accountsPartial({
        authority: owner.publicKey,
        negotiation: negotiationPDA,
        ...queueAccounts("match_ceiling", matchOffset),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(matchOffset, t, `match_ceiling #${id}`);
    return settled;
  }

  describe("Function 1: reservation-price matching", () => {
    it("reveals the midpoint on overlap, rounding an odd sum down", async () => {
      // 1001 + 3000 = 4001 → 2000. Exercises (a & b) + ((a ^ b) >> 1).
      const ev = await negotiate(newId(), 1001n, 3000n);
      expect(ev.matched).to.equal(true);
      expect(ev.price.toString()).to.equal("2000");
    });

    it("reveals nothing but 'no deal' when there is no overlap", async () => {
      const ev = await negotiate(newId(), 5000n, 3000n);
      expect(ev.matched).to.equal(false);
      expect(ev.price.toString()).to.equal("0");
    });

    it("matches when the ceiling equals the floor exactly", async () => {
      const ev = await negotiate(newId(), 2500n, 2500n);
      expect(ev.matched).to.equal(true);
      expect(ev.price.toString()).to.equal("2500");
    });
  });

  // ── Function 2 ──────────────────────────────────────────────────────────

  async function getValidatorTimestamp(): Promise<number> {
    const slot = await provider.connection.getSlot("confirmed");
    const t = await provider.connection.getBlockTime(slot);
    if (t === null) throw new Error("Could not fetch block time from validator");
    return t;
  }

  describe("Function 2: sealed-quote RFQ", () => {
    it("awards the lowest quote and reveals only winner and price", async () => {
      const rfqId = newId();
      const [rfqPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("rfq"),
          owner.publicKey.toBuffer(),
          new anchor.BN(rfqId).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const openOffset = newOffset();
      const opened = awaitEvent("rfqOpenedEvent", "rfq", rfqPDA);
      let t = Date.now();
      // Long enough for three sequential quotes to finalize before the deadline.
      await program.methods
        .createRfq(openOffset, new anchor.BN(rfqId), new anchor.BN(90))
        .accountsPartial({
          authority: owner.publicKey,
          rfq: rfqPDA,
          ...queueAccounts("open_rfq_state", openOffset),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(openOffset, t, "open_rfq_state");
      await opened;

      // Three distinct sellers. AA submits each quote (it is the relayer), so
      // the seller's identity travels only inside the encrypted Quote.
      const sellers = [
        { kp: anchor.web3.Keypair.generate(), amount: 700n },
        { kp: anchor.web3.Keypair.generate(), amount: 400n },
        { kp: anchor.web3.Keypair.generate(), amount: 900n },
      ];

      for (const [i, s] of sellers.entries()) {
        const { lo, hi } = splitPubkeyToU128s(s.kp.publicKey.toBytes());
        const { publicKey, cipher } = newCipher();
        const nonce = randomBytes(16);
        // Plaintext order must match the circuit's Quote: seller lo, hi, amount.
        const ct = cipher.encrypt([lo, hi, s.amount], nonce);
        const offset = newOffset();
        const placed = awaitEvent("quotePlacedEvent", "rfq", rfqPDA);
        t = Date.now();
        await program.methods
          .placeQuote(
            offset,
            Array.from(ct[0]),
            Array.from(ct[1]),
            Array.from(ct[2]),
            Array.from(publicKey),
            nonceArg(nonce)
          )
          .accountsPartial({
            authority: owner.publicKey,
            rfq: rfqPDA,
            ...queueAccounts("place_quote", offset),
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        // Must finalize before the next quote: each reads the state the last wrote.
        await finalize(offset, t, `place_quote #${i + 1}`);
        const ev = await placed;
        expect(ev.quoteCount).to.equal(i + 1);
      }

      const { endTime } = await program.account.rfq.fetch(rfqPDA);
      while ((await getValidatorTimestamp()) < endTime.toNumber()) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      const closed = awaitEvent("rfqClosedEvent", "rfq", rfqPDA);
      await program.methods
        .closeRfq()
        .accountsPartial({ authority: owner.publicKey, rfq: rfqPDA })
        .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
      expect((await closed).quoteCount).to.equal(3);

      const awardOffset = newOffset();
      const awarded = awaitEvent("rfqAwardedEvent", "rfq", rfqPDA);
      t = Date.now();
      await program.methods
        .awardRfq(awardOffset)
        .accountsPartial({
          authority: owner.publicKey,
          rfq: rfqPDA,
          ...queueAccounts("award_rfq", awardOffset),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(awardOffset, t, "award_rfq");
      const ev = await awarded;

      expect(ev.price.toString()).to.equal("400");
      expect(Buffer.from(ev.winner).toString("hex")).to.equal(
        Buffer.from(sellers[1].kp.publicKey.toBytes()).toString("hex")
      );
      // The event carries winner and price only — the losing quotes (700, 900)
      // have no field to appear in.
      expect(Object.keys(ev).sort()).to.deep.equal(["price", "rfq", "rfqId", "winner"]);
    });
  });

  // ── Function 3 ──────────────────────────────────────────────────────────

  describe("Function 3: seller scores without revealing the evaluator", () => {
    it("aggregates per seller, clamps latency, and leaves other slots at zero", async () => {
      const boardId = newId();
      const [boardPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("scoreboard"),
          owner.publicKey.toBuffer(),
          new anchor.BN(boardId).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const openOffset = newOffset();
      const opened = awaitEvent("scoreboardOpenedEvent", "scoreboard", boardPDA);
      let t = Date.now();
      await program.methods
        .createScoreboard(openOffset, new anchor.BN(boardId))
        .accountsPartial({
          authority: owner.publicKey,
          scoreboard: boardPDA,
          ...queueAccounts("open_scoreboard", openOffset),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(openOffset, t, "open_scoreboard");
      await opened;

      // slot, delivered, format_ok, latency_ms. 70000 must clamp to 60000.
      const ratings: Array<[number, boolean, boolean, number]> = [
        [2, true, true, 1200],
        [2, true, false, 800],
        [5, false, false, 70000],
      ];
      for (const [i, [slot, delivered, formatOk, latency]] of ratings.entries()) {
        const { publicKey, cipher } = newCipher();
        const nonce = randomBytes(16);
        // Plaintext order must match Rating: slot, delivered, format_ok, latency_ms.
        const ct = cipher.encrypt(
          [BigInt(slot), BigInt(delivered ? 1 : 0), BigInt(formatOk ? 1 : 0), BigInt(latency)],
          nonce
        );
        const offset = newOffset();
        const submitted = awaitEvent("ratingSubmittedEvent", "scoreboard", boardPDA);
        t = Date.now();
        await program.methods
          .submitRating(
            offset,
            Array.from(ct[0]),
            Array.from(ct[1]),
            Array.from(ct[2]),
            Array.from(ct[3]),
            Array.from(publicKey),
            nonceArg(nonce)
          )
          .accountsPartial({
            authority: owner.publicKey,
            scoreboard: boardPDA,
            ...queueAccounts("submit_rating", offset),
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        await finalize(offset, t, `submit_rating #${i + 1}`);
        expect((await submitted).ratingCount).to.equal(i + 1);
      }

      const revealOffset = newOffset();
      const revealed = awaitEvent("scoresRevealedEvent", "scoreboard", boardPDA);
      t = Date.now();
      await program.methods
        .revealScores(revealOffset)
        .accountsPartial({
          authority: owner.publicKey,
          scoreboard: boardPDA,
          ...queueAccounts("reveal_scores", revealOffset),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(revealOffset, t, "reveal_scores");
      const ev = await revealed;

      const want = (slot2: number, slot5: number) => {
        const a = new Array(8).fill(0);
        a[2] = slot2;
        a[5] = slot5;
        return a;
      };
      expect(ev.ratings.map(Number)).to.deep.equal(want(2, 1));
      expect(ev.delivered.map(Number)).to.deep.equal(want(2, 0));
      expect(ev.formatOk.map(Number)).to.deep.equal(want(1, 0));
      expect(ev.latencySumMs.map(Number)).to.deep.equal(want(2000, 60000));
    });
  });

  // ── Function 4 ──────────────────────────────────────────────────────────

  /** Runs one joint purchase and returns `reached` plus each buyer's decrypted share. */
  async function jointPurchase(caps: bigint[], price: bigint) {
    const buyers = caps.map(() => newCipher());
    const nonces = caps.map(() => randomBytes(16));
    const cts = caps.map((c, i) => buyers[i].cipher.encrypt([c], nonces[i])[0]);

    const offset = newOffset();
    const computation = getComputationAccAddress(arciumEnv.arciumClusterOffset, offset);
    const decided = awaitEvent("jointPurchaseDecidedEvent", "computation", computation);
    const t = Date.now();
    await program.methods
      .jointPurchase(
        offset,
        cts.map((c) => Array.from(c)),
        buyers.map((b) => Array.from(b.publicKey)),
        nonces.map((n) => nonceArg(n)),
        new anchor.BN(price.toString())
      )
      .accountsPartial({
        authority: owner.publicKey,
        ...queueAccounts("joint_purchase", offset),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(offset, t, `joint_purchase price=${price}`);
    const ev = await decided;

    // Each buyer decrypts only its own slot, with its own key.
    const shares = buyers.map((b, i) => {
      const nonce = new anchor.BN(ev.shareNonces[i].toString()).toArrayLike(Buffer, "le", 16);
      return b.cipher.decrypt([ev.shareCiphertexts[i]], new Uint8Array(nonce))[0];
    });
    return { reached: ev.reached as boolean, shares };
  }

  describe("Function 4: joint purchase without revealing the participants", () => {
    it("splits pro rata (rounded up) when the caps reach the price", async () => {
      const r = await jointPurchase([600n, 0n, 900n], 1000n);
      expect(r.reached).to.equal(true);
      // ceil(600*1000/1500) = 400, 0, ceil(900*1000/1500) = 600.
      expect(r.shares.map(String)).to.deep.equal(["400", "0", "600"]);
    });

    it("charges no one when the caps fall short", async () => {
      const r = await jointPurchase([100n, 100n, 100n], 1000n);
      expect(r.reached).to.equal(false);
      expect(r.shares.map(String)).to.deep.equal(["0", "0", "0"]);
    });
  });

  // ── Function 5 ──────────────────────────────────────────────────────────

  /** A deterministic catalog of `n` entries: category, format, price. */
  function makeCatalog(n: number) {
    const categories: number[] = [];
    const formats: number[] = [];
    const prices: number[] = [];
    for (let i = 0; i < n; i++) {
      categories.push((i % 5) + 1);
      formats.push((i % 3) + 1);
      prices.push(1000 * ((i % 9) + 1));
    }
    return { categories, formats, prices };
  }

  /** The public search the sealed one is compared against. */
  function plainSearch(
    c: ReturnType<typeof makeCatalog>,
    q: { category: number; format: number; maxPrice: number }
  ): bigint {
    let mask = 0n;
    for (let i = 0; i < c.categories.length; i++) {
      const ok =
        c.categories[i] === q.category &&
        (q.format === 0 || c.formats[i] === q.format) &&
        c.prices[i] <= q.maxPrice;
      if (ok) mask |= 1n << BigInt(i);
    }
    return mask;
  }

  describe("Function 5: endpoint search without revealing the query", () => {
    const query = { category: 3, format: 0, maxPrice: 5000 };

    for (const n of [8, 16, 32, 64] as const) {
      it(`returns the same matches as a plain filter over ${n} entries`, async () => {
        const catalog = makeCatalog(n);
        const [catalogPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from("catalog"), owner.publicKey.toBuffer(), Buffer.from([n])],
          program.programId
        );
        await program.methods
          .setCatalog(n, 1, Buffer.from(catalog.categories), Buffer.from(catalog.formats), catalog.prices)
          .accountsPartial({ authority: owner.publicKey, catalog: catalogPDA })
          .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });

        const { publicKey, cipher } = newCipher();
        const nonce = randomBytes(16);
        // Plaintext order must match SearchQuery: category, format, max_price_micro.
        const ct = cipher.encrypt(
          [BigInt(query.category), BigInt(query.format), BigInt(query.maxPrice)],
          nonce
        );
        const circuit = `search_catalog_${n}` as const;
        const method = `searchCatalog${n}` as const;
        const offset = newOffset();
        const computation = getComputationAccAddress(arciumEnv.arciumClusterOffset, offset);
        const found = awaitEvent("searchResultEvent", "computation", computation);

        const plainStart = process.hrtime.bigint();
        const expected = plainSearch(catalog, query);
        const plainUs = Number(process.hrtime.bigint() - plainStart) / 1000;

        const t = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (program.methods as any)
          [method](
            offset,
            Array.from(ct[0]),
            Array.from(ct[1]),
            Array.from(ct[2]),
            Array.from(publicKey),
            nonceArg(nonce)
          )
          .accountsPartial({
            authority: owner.publicKey,
            catalog: catalogPDA,
            ...queueAccounts(circuit, offset),
          })
          // Pushing 3·n plaintext arguments costs compute; give the queue room.
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        const ms = await finalize(offset, t, `search_catalog_${n}`);
        console.log(`   [compare] N=${n}: sealed ${ms} ms vs plain ${plainUs.toFixed(1)} µs`);

        const ev = await found;
        const evNonce = new anchor.BN(ev.nonce.toString()).toArrayLike(Buffer, "le", 16);
        const mask = cipher.decrypt([ev.ciphertext], new Uint8Array(evNonce))[0];
        expect(mask.toString(2)).to.equal(expected.toString(2));
        expect(expected).to.not.equal(0n, "the query should match something");
      });
    }
  });

  // ── Comp-def initialization ─────────────────────────────────────────────

  const INIT_METHOD: Record<(typeof CIRCUITS)[number], string> = {
    seal_floor: "initSealFloorCompDef",
    match_ceiling: "initMatchCeilingCompDef",
    open_rfq_state: "initOpenRfqStateCompDef",
    place_quote: "initPlaceQuoteCompDef",
    award_rfq: "initAwardRfqCompDef",
    open_scoreboard: "initOpenScoreboardCompDef",
    submit_rating: "initSubmitRatingCompDef",
    reveal_scores: "initRevealScoresCompDef",
    joint_purchase: "initJointPurchaseCompDef",
    search_catalog_8: "initSearchCatalog8CompDef",
    search_catalog_16: "initSearchCatalog16CompDef",
    search_catalog_32: "initSearchCatalog32CompDef",
    search_catalog_64: "initSearchCatalog64CompDef",
  };

  async function initCompDef(
    program: Program<AaMxe>,
    owner: anchor.web3.Keypair,
    circuitName: (typeof CIRCUITS)[number]
  ): Promise<string> {
    const offset = getCompDefAccOffset(circuitName);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [
        getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(),
        offset,
      ],
      getArciumProgramId()
    )[0];

    // Comp defs persist on chain. On devnet a second run must not try again.
    if (await provider.connection.getAccountInfo(compDefPDA)) {
      console.log(`   ${circuitName}: comp def already initialized, skipping`);
      return "existing";
    }

    const arciumProgram = getArciumProgram(provider as anchor.AnchorProvider);
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await (program.methods as any)
      [INIT_METHOD[circuitName]]()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([owner])
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });

    const rawCircuit = fs.readFileSync(`build/${circuitName}.arcis`);
    await uploadCircuit(
      provider as anchor.AnchorProvider,
      circuitName,
      program.programId,
      rawCircuit,
      true
    );
    return sig;
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }
    if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function readKpJson(path: string): anchor.web3.Keypair {
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path).toString()))
  );
}
