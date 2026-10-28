/**
 * The five MXE functions as AA operations on the aa_mxe program.
 *
 * Each takes plain inputs, seals them for the MXE, runs the computation(s) and
 * returns the revealed outcome together with every computation it ran. The
 * orchestration (who the parties are, what gets paid, what it is compared
 * against, what is recorded) is the job's; this file only speaks the protocol,
 * mirroring mxe/tests/aa_mxe.ts.
 *
 * Amounts are micro-USDC throughout.
 */
import { randomBytes } from "crypto";
import * as anchor from "@anchor-lang/core";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { RescueCipher, deserializeLE, x25519 } from "@arcium-hq/client";
import { eventOf, type ComputationRun, type MxeChain } from "./chain";

export interface MxeOutcome<R> {
  result: R;
  runs: ComputationRun[];
  /** Sum over the runs, queue → callback. */
  latencyMs: number;
  /** Sum over the runs and any plain transactions in between. */
  lamports: number;
}

/** A party's one-off x25519 key and the cipher it shares with the MXE. */
export interface Party {
  publicKey: Uint8Array;
  cipher: RescueCipher;
}

export async function newParty(chain: MxeChain): Promise<Party> {
  const sk = x25519.utils.randomSecretKey();
  return {
    publicKey: x25519.getPublicKey(sk),
    cipher: new RescueCipher(x25519.getSharedSecret(sk, await chain.mxePublicKey())),
  };
}

function seal(p: Party, values: bigint[]): { cts: number[][]; nonceArg: anchor.BN } {
  const nonce = randomBytes(16);
  return {
    cts: p.cipher.encrypt(values, nonce).map((c) => Array.from(c)),
    nonceArg: new anchor.BN(deserializeLE(nonce).toString()),
  };
}

function open(p: Party, ciphertext: number[], nonce: unknown): bigint {
  const n = new anchor.BN(String(nonce)).toArrayLike(Buffer, "le", 16);
  return p.cipher.decrypt([ciphertext], new Uint8Array(n))[0];
}

const le64 = (n: anchor.BN | number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);
const newId = () => new anchor.BN(randomBytes(6), "hex");

function outcome<R>(result: R, runs: ComputationRun[], extraLamports = 0): MxeOutcome<R> {
  return {
    result,
    runs,
    latencyMs: runs.reduce((a, r) => a + r.latencyMs, 0),
    lamports: runs.reduce((a, r) => a + r.lamports, 0) + extraLamports,
  };
}

// ── Function 1: reservation-price matching ────────────────────────────────

export interface NegotiationResult {
  matched: boolean;
  /** Midpoint of floor and ceiling on overlap; 0 otherwise. */
  priceMicro: bigint;
}

/** The seller seals its floor, the buyer its ceiling; only the outcome is revealed. */
export async function negotiate(
  chain: MxeChain,
  floorMicro: bigint,
  ceilingMicro: bigint
): Promise<MxeOutcome<NegotiationResult>> {
  const id = newId();
  const negotiation = chain.pda([Buffer.from("negotiation"), chain.authority.toBuffer(), le64(id)]);

  const seller = await newParty(chain);
  const f = seal(seller, [floorMicro]);
  const sealRun = await chain.queue(
    "sealFloor",
    "seal_floor",
    [id, f.cts[0], Array.from(seller.publicKey), f.nonceArg],
    { negotiation }
  );
  eventOf(sealRun, "floorSealedEvent");

  const buyer = await newParty(chain);
  const c = seal(buyer, [ceilingMicro]);
  const matchRun = await chain.queue(
    "matchCeiling",
    "match_ceiling",
    [c.cts[0], Array.from(buyer.publicKey), c.nonceArg],
    { negotiation }
  );
  const ev = eventOf(matchRun, "negotiationSettledEvent");
  return outcome(
    { matched: Boolean(ev.matched), priceMicro: BigInt(String(ev.price)) },
    [sealRun, matchRun]
  );
}

// ── Function 2: sealed-quote RFQ ──────────────────────────────────────────

export interface RfqResult {
  winner: string;
  priceMicro: bigint;
  quoteCount: number;
}

/**
 * Opens an RFQ, folds in each sealed quote, waits out the deadline, and
 * reveals the lowest. The AA relays every quote, so a seller's identity
 * travels only inside its encrypted quote.
 */
export async function sealedRfq(
  chain: MxeChain,
  quotes: { seller: PublicKey; amountMicro: bigint }[],
  durationSec: number
): Promise<MxeOutcome<RfqResult>> {
  const id = newId();
  const rfq = chain.pda([Buffer.from("rfq"), chain.authority.toBuffer(), le64(id)]);
  const runs: ComputationRun[] = [];

  const openRun = await chain.queue("createRfq", "open_rfq_state", [id, new anchor.BN(durationSec)], { rfq });
  const opened = eventOf(openRun, "rfqOpenedEvent");
  runs.push(openRun);

  for (const q of quotes) {
    const p = await newParty(chain);
    const b = q.seller.toBytes();
    const lo = deserializeLE(b.slice(0, 16));
    const hi = deserializeLE(b.slice(16, 32));
    // Order must match the circuit's Quote: seller lo, hi, amount.
    const s = seal(p, [lo, hi, q.amountMicro]);
    const run = await chain.queue(
      "placeQuote",
      "place_quote",
      [s.cts[0], s.cts[1], s.cts[2], Array.from(p.publicKey), s.nonceArg],
      { rfq }
    );
    eventOf(run, "quotePlacedEvent");
    runs.push(run);
  }

  const endTime = Number(String(opened.endTime));
  while ((await chain.clusterTime()) < endTime) await sleep(2000);
  const closed = await chain.send("closeRfq", [], { rfq });

  const awardRun = await chain.queue("awardRfq", "award_rfq", [], { rfq });
  const ev = eventOf(awardRun, "rfqAwardedEvent");
  runs.push(awardRun);
  return outcome(
    {
      winner: new PublicKey(Uint8Array.from(ev.winner as number[])).toBase58(),
      priceMicro: BigInt(String(ev.price)),
      quoteCount: quotes.length,
    },
    runs,
    closed.lamports
  );
}

// ── Function 3: seller scores without revealing the evaluator ─────────────

export const SCORE_SLOTS = 8;

export interface Rating {
  slot: number;
  delivered: boolean;
  formatOk: boolean;
  latencyMs: number;
}

export interface ScoreReport {
  ratingCount: number;
  ratings: number[];
  delivered: number[];
  formatOk: number[];
  latencySumMs: number[];
}

export function scoreboardPda(chain: MxeChain, boardId: anchor.BN): PublicKey {
  return chain.pda([Buffer.from("scoreboard"), chain.authority.toBuffer(), le64(boardId)]);
}

export async function openScoreboard(chain: MxeChain): Promise<MxeOutcome<{ boardId: string }>> {
  const boardId = newId();
  const run = await chain.queue("createScoreboard", "open_scoreboard", [boardId], {
    scoreboard: scoreboardPda(chain, boardId),
  });
  eventOf(run, "scoreboardOpenedEvent");
  return outcome({ boardId: boardId.toString() }, [run]);
}

export async function submitRating(
  chain: MxeChain,
  boardId: string,
  r: Rating
): Promise<MxeOutcome<{ ratingCount: number }>> {
  if (!Number.isInteger(r.slot) || r.slot < 0 || r.slot >= SCORE_SLOTS) {
    throw new Error(`slot must be 0..${SCORE_SLOTS - 1}`);
  }
  const p = await newParty(chain);
  // Order must match the circuit's Rating: slot, delivered, format_ok, latency_ms.
  const s = seal(p, [BigInt(r.slot), r.delivered ? 1n : 0n, r.formatOk ? 1n : 0n, BigInt(Math.max(0, Math.round(r.latencyMs)))]);
  return submitSealedRating(chain, boardId, s.cts, p.publicKey, s.nonceArg);
}

/**
 * A rating already sealed by the evaluator, relayed as is: the AA never sees
 * the plaintext. `cts` are the four Rating fields, in circuit order.
 */
export async function submitSealedRating(
  chain: MxeChain,
  boardId: string,
  cts: number[][],
  evaluatorPubkey: Uint8Array,
  nonceArg: anchor.BN
): Promise<MxeOutcome<{ ratingCount: number }>> {
  if (cts.length !== 4 || cts.some((c) => c.length !== 32)) throw new Error("a rating is four 32-byte ciphertexts");
  if (evaluatorPubkey.length !== 32) throw new Error("evaluator public key must be 32 bytes");
  const run = await chain.queue(
    "submitRating",
    "submit_rating",
    [cts[0], cts[1], cts[2], cts[3], Array.from(evaluatorPubkey), nonceArg],
    { scoreboard: scoreboardPda(chain, new anchor.BN(boardId)) }
  );
  const ev = eventOf(run, "ratingSubmittedEvent");
  return outcome({ ratingCount: Number(ev.ratingCount) }, [run]);
}

export async function revealScores(chain: MxeChain, boardId: string): Promise<MxeOutcome<ScoreReport>> {
  const run = await chain.queue("revealScores", "reveal_scores", [], {
    scoreboard: scoreboardPda(chain, new anchor.BN(boardId)),
  });
  const ev = eventOf(run, "scoresRevealedEvent");
  const arr = (k: string) => (ev[k] as unknown[]).map((x) => Number(x));
  return outcome(
    {
      ratingCount: Number(ev.ratingCount),
      ratings: arr("ratings"),
      delivered: arr("delivered"),
      formatOk: arr("formatOk"),
      latencySumMs: arr("latencySumMs"),
    },
    [run]
  );
}

// ── Function 4: joint purchase without revealing the participants ─────────

export const JOINT_BUYERS = 3;
export const U32_MAX = 0xffff_ffffn;

export interface JointPurchaseResult {
  reached: boolean;
  /** Each buyer's share, decrypted with that buyer's own key. */
  sharesMicro: bigint[];
}

export async function jointPurchase(
  chain: MxeChain,
  capsMicro: bigint[],
  priceMicro: bigint
): Promise<MxeOutcome<JointPurchaseResult>> {
  if (capsMicro.length !== JOINT_BUYERS) throw new Error(`exactly ${JOINT_BUYERS} caps (0 for a non-participant)`);
  for (const v of [...capsMicro, priceMicro]) {
    if (v < 0n || v > U32_MAX) throw new Error("caps and price must fit in u32 micro-USDC");
  }
  if (priceMicro === 0n) throw new Error("price must be above zero");

  const buyers = await Promise.all(capsMicro.map(() => newParty(chain)));
  const sealed = capsMicro.map((c, i) => seal(buyers[i], [c]));
  const run = await chain.queue(
    "jointPurchase",
    "joint_purchase",
    [
      sealed.map((s) => s.cts[0]),
      buyers.map((b) => Array.from(b.publicKey)),
      sealed.map((s) => s.nonceArg),
      Number(priceMicro),
    ],
    {}
  );
  const ev = eventOf(run, "jointPurchaseDecidedEvent");
  const cts = ev.shareCiphertexts as number[][];
  const nonces = ev.shareNonces as unknown[];
  return outcome(
    { reached: Boolean(ev.reached), sharesMicro: buyers.map((b, i) => open(b, cts[i], nonces[i])) },
    [run]
  );
}

// ── Function 5: endpoint search without revealing the query ───────────────

export const CATALOG_SIZES = [8, 16, 32, 64] as const;
export type CatalogSize = (typeof CATALOG_SIZES)[number];

export interface CatalogEntry {
  category: number;
  /** 1.. ; 0 in a query means any format. */
  format: number;
  priceMicro: number;
}

export interface SearchQuery {
  category: number;
  format: number;
  maxPriceMicro: number;
}

export function catalogPda(chain: MxeChain, size: CatalogSize): PublicKey {
  return chain.pda([Buffer.from("catalog"), chain.authority.toBuffer(), Buffer.from([size])]);
}

/** Publish (or replace) the plain catalog the sealed query is matched against. */
export async function setCatalog(
  chain: MxeChain,
  size: CatalogSize,
  version: number,
  entries: CatalogEntry[]
): Promise<{ tx: string; lamports: number }> {
  if (entries.length !== size) throw new Error(`catalog of size ${size} needs ${size} entries`);
  return chain.send(
    "setCatalog",
    [
      size,
      version,
      Buffer.from(entries.map((e) => e.category)),
      Buffer.from(entries.map((e) => e.format)),
      entries.map((e) => e.priceMicro),
    ],
    { catalog: catalogPda(chain, size) }
  );
}

/** Indices (bit i = entry i) matching the query; only the querier can read them. */
export async function sealedSearch(
  chain: MxeChain,
  size: CatalogSize,
  q: SearchQuery
): Promise<MxeOutcome<{ mask: bigint; matches: number[] }>> {
  const p = await newParty(chain);
  // Order must match SearchQuery: category, format, max_price_micro.
  const s = seal(p, [BigInt(q.category), BigInt(q.format), BigInt(q.maxPriceMicro)]);
  const run = await chain.queue(
    `searchCatalog${size}`,
    `search_catalog_${size}`,
    [s.cts[0], s.cts[1], s.cts[2], Array.from(p.publicKey), s.nonceArg],
    { catalog: catalogPda(chain, size) },
    // Pushing 3·N plaintext arguments costs compute; give the queue room.
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]
  );
  const ev = eventOf(run, "searchResultEvent");
  const mask = open(p, ev.ciphertext as number[], ev.nonce);
  return outcome({ mask, matches: maskToIndices(mask, size) }, [run]);
}

/** The same filter, in the clear — the comparison side for function 5. */
export function plainSearch(entries: CatalogEntry[], q: SearchQuery): number[] {
  const out: number[] = [];
  entries.forEach((e, i) => {
    if (e.category === q.category && (q.format === 0 || e.format === q.format) && e.priceMicro <= q.maxPriceMicro) {
      out.push(i);
    }
  });
  return out;
}

export function maskToIndices(mask: bigint, size: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) if ((mask >> BigInt(i)) & 1n) out.push(i);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
