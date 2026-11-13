/**
 * The aa_mxe program on an Arcium cluster, as the AA sees it: queue a
 * computation, wait for the cluster to finalize it, read the callback's event.
 *
 * Instructions are built from the committed IDL (mxe/idl/aa_mxe.json, checked
 * against the program in CI), with every account passed explicitly. The fee
 * payer — and the `authority` of every PDA the program creates — is a Circle
 * DCW wallet on Solana devnet, separate from the mainnet payment wallets.
 *
 * Measurements are taken here, once, so that each record carries the same
 * kind of number: latency is queue → callback event; cost is the fee payer's
 * balance delta over the same span (tx fees, the computation fee, and rent for
 * any account the step created).
 *
 * Nothing is retried or substituted on failure. An error propagates with the
 * computation offset attached once the queue transaction has confirmed, so the
 * record can say which computation failed — and says nothing when none was
 * queued.
 */
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import * as anchor from "@anchor-lang/core";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  awaitComputationFinalization,
  getArciumProgramId,
  getArciumSignerAccAddress,
  getClockAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getArciumProgram,
} from "@arcium-hq/client";

/** Anchor's wallet contract, as far as `.rpc()` needs it. */
export interface MxeWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export interface MxeChainConfig {
  connection: Connection;
  wallet: MxeWallet;
  programId: PublicKey;
  clusterOffset: number;
  /** Queue → finalization timeout. Devnet MPC takes seconds to minutes. */
  finalizeTimeoutMs?: number;
}

/** One finalized computation, as measured. */
export interface ComputationRun {
  circuit: string;
  /** u64, decimal. */
  offset: string;
  account: string;
  queueTx: string;
  callbackTx: string;
  latencyMs: number;
  /** Fee payer balance delta, queue → finalize. */
  lamports: number;
  /**
   * The circuit's compute units, as its computation definition registered
   * them (u64, decimal) — the amount the base fee is priced on. Read from
   * chain; undefined if the read failed.
   */
  cuAmount?: string;
  /** The computation's execution fee as the Arcium program recorded it, in lamports. */
  baseFeeLamports?: number;
  priorityFeeLamports?: number;
  /**
   * Rent returned from the computation account once it finalized
   * (claim_computation_rent). `lamports` above is measured before the claim,
   * so it includes the deposit; subtract this for the net cost.
   */
  rentReclaimedLamports?: number;
  /** Events the program emitted in the callback transaction, by name (camelCase). */
  events: { name: string; data: Record<string, unknown> }[];
}

/** A failure after the computation was queued: the offset is real. */
export class ComputationFailed extends Error {
  constructor(
    message: string,
    public readonly circuit: string,
    public readonly offset: string,
    public readonly account: string,
    public readonly queueTx?: string
  ) {
    super(message);
    this.name = "ComputationFailed";
  }
}

const IDL_PATH = path.join(__dirname, "..", "..", "mxe", "idl", "aa_mxe.json");

export function loadIdl(programId: PublicKey): anchor.Idl {
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8")) as anchor.Idl;
  // The committed IDL carries the localnet placeholder id; the deployed one
  // is derived from the deploy key and supplied by config.
  return { ...idl, address: programId.toBase58() };
}

export class MxeChain {
  readonly program: anchor.Program;
  readonly provider: anchor.AnchorProvider;
  private mxeKey?: Uint8Array;
  private readonly cuByCircuit = new Map<string, string>();
  private readonly parser: anchor.EventParser;

  constructor(readonly cfg: MxeChainConfig) {
    this.provider = new anchor.AnchorProvider(cfg.connection, cfg.wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const idl = loadIdl(cfg.programId);
    this.program = new anchor.Program(idl, this.provider);
    // The program's coder works on the camelCased IDL, so event and field
    // names come out as the tests see them (e.g. "jointPurchaseDecidedEvent").
    this.parser = new anchor.EventParser(cfg.programId, this.program.coder);
  }

  get authority(): PublicKey {
    return this.cfg.wallet.publicKey;
  }

  /** The MXE's x25519 key, which clients encrypt to. Fetched once. */
  async mxePublicKey(): Promise<Uint8Array> {
    if (this.mxeKey) return this.mxeKey;
    for (let i = 0; i < 10; i++) {
      const k = await getMXEPublicKey(this.provider, this.cfg.programId);
      if (k) return (this.mxeKey = k);
      await sleep(1000);
    }
    throw new Error("MXE x25519 public key not available (is the MXE initialized on this cluster?)");
  }

  pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.cfg.programId)[0];
  }

  /** Accounts every queue instruction shares, for one circuit and offset. */
  private queueAccounts(circuit: string, offset: anchor.BN): Record<string, PublicKey> {
    const c = this.cfg.clusterOffset;
    return {
      signPdaAccount: getArciumSignerAccAddress(this.cfg.programId),
      mxeAccount: getMXEAccAddress(this.cfg.programId),
      mempoolAccount: getMempoolAccAddress(c),
      executingPool: getExecutingPoolAccAddress(c),
      computationAccount: getComputationAccAddress(c, offset),
      compDefAccount: getCompDefAccAddress(
        this.cfg.programId,
        Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
      ),
      clusterAccount: getClusterAccAddress(c),
      poolAccount: getFeePoolAccAddress(),
      clockAccount: getClockAccAddress(),
      systemProgram: SystemProgram.programId,
      arciumProgram: getArciumProgramId(),
    };
  }

  /**
   * Queue `method` (whose first argument is the computation offset), wait for
   * finalization, and return the callback's events with the measurements.
   */
  async queue(
    method: string,
    circuit: string,
    args: unknown[],
    accounts: Record<string, PublicKey>,
    preInstructions: anchor.web3.TransactionInstruction[] = []
  ): Promise<ComputationRun> {
    const offset = new anchor.BN(randomBytes(8), "hex");
    const account = getComputationAccAddress(this.cfg.clusterOffset, offset).toBase58();
    const before = await this.cfg.connection.getBalance(this.authority, "confirmed");
    const t0 = Date.now();

    // Before this confirms, no computation exists — let the error say so by
    // propagating as is, without an offset.
    const queueTx: string = await (this.program.methods as any)
      [method](offset, ...args)
      .accountsStrict({ authority: this.authority, ...accounts, ...this.queueAccounts(circuit, offset) })
      .preInstructions(preInstructions)
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const fail = (msg: string) =>
      new ComputationFailed(msg, circuit, offset.toString(), account, queueTx);

    // skipPreflight: a failed queue tx still lands; check it actually succeeded.
    const queued = await this.cfg.connection.getTransaction(queueTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (queued?.meta?.err) throw fail(`queue tx failed: ${JSON.stringify(queued.meta.err)}`);

    // What the Arcium program charges, read while the computation account is
    // fresh. Measurement only: a failed read leaves the fields undefined.
    const fees = await this.readFees(circuit, account);

    let newest: string;
    try {
      newest = await awaitComputationFinalization(
        this.provider,
        offset,
        this.cfg.programId,
        "confirmed",
        this.cfg.finalizeTimeoutMs ?? 300_000
      );
    } catch (err) {
      throw fail(`not finalized: ${String(err)}`);
    }
    const latencyMs = Date.now() - t0;
    const after = await this.cfg.connection.getBalance(this.authority, "confirmed");

    // More than one callback tx can land for a computation: the nodes may
    // submit it twice, and the late one fails with Arcium's 6204
    // ("Callback computation already called"). The newest signature on the
    // account is not necessarily the one that delivered the result, so take
    // the successful transaction that carries this program's event.
    const found = await this.findCallback(new PublicKey(account), newest);
    if ("error" in found) throw fail(found.error);
    const { callbackTx, events } = found;

    // The computation account holds a rent deposit until it is claimed back.
    // Not claiming it was most of the per-run cost (11/13). A failed claim is
    // logged and left for the next run's sweep; it never fails the computation.
    const rentReclaimedLamports = await this.claimRent(offset).catch((err) => {
      console.warn(`[MXE] rent claim for ${account} failed: ${String(err).slice(0, 200)}`);
      return undefined;
    });

    return {
      circuit,
      offset: offset.toString(),
      account,
      queueTx,
      callbackTx,
      latencyMs,
      lamports: before - after,
      ...fees,
      rentReclaimedLamports,
      events,
    };
  }

  /**
   * Claims a finalized computation's rent back to the signer (its payer).
   * Returns the lamports returned, or 0 if the account was already closed.
   */
  async claimRent(offset: anchor.BN): Promise<number> {
    const account = getComputationAccAddress(this.cfg.clusterOffset, offset);
    const info = await this.cfg.connection.getAccountInfo(account, "confirmed");
    if (!info) return 0;
    await getArciumProgram(this.provider)
      .methods.claimComputationRent(offset, this.cfg.clusterOffset)
      .accountsPartial({ signer: this.authority })
      .rpc({ commitment: "confirmed" });
    return info.lamports;
  }

  /**
   * For a computation the cluster never executed: once Arcium counts it as
   * expired, reclaim its fee and then its rent. Throws Arcium's
   * ComputationNotExpired (6210) until then.
   */
  async reclaimExpired(offset: anchor.BN): Promise<number> {
    const account = getComputationAccAddress(this.cfg.clusterOffset, offset);
    const info = await this.cfg.connection.getAccountInfo(account, "confirmed");
    if (!info) return 0;
    const arcium = getArciumProgram(this.provider);
    const reclaim = await arcium.methods
      .reclaimExpiredComputationFee(offset, this.cfg.programId)
      .accountsPartial({ signer: this.authority })
      .instruction();
    const claim = await arcium.methods
      .claimComputationRent(offset, this.cfg.clusterOffset)
      .accountsPartial({ signer: this.authority })
      .instruction();
    await this.provider.sendAndConfirm(new Transaction().add(reclaim, claim), [], { commitment: "confirmed" });
    return info.lamports;
  }

  /** Status of a computation account ("queued", "finalized", ...), or undefined if it is gone. */
  async computationStatus(offset: anchor.BN): Promise<string | undefined> {
    const account = getComputationAccAddress(this.cfg.clusterOffset, offset);
    const acc = (await getArciumProgram(this.provider).account.computationAccount.fetchNullable(account, "confirmed")) as {
      status: Record<string, unknown>;
    } | null;
    return acc ? Object.keys(acc.status)[0] : undefined;
  }

  /** The computation's successful callback transaction and its events. */
  private async findCallback(
    computation: PublicKey,
    newest: string
  ): Promise<{ callbackTx: string; events: ComputationRun["events"] } | { error: string }> {
    const sigs = await this.cfg.connection.getSignaturesForAddress(computation, { limit: 20 }, "confirmed");
    const order = [newest, ...sigs.map((s) => s.signature).filter((s) => s !== newest)];
    let firstError: string | undefined;
    for (const sig of order) {
      const tx = await this.cfg.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;
      if (tx.meta.err) {
        firstError ??= `callback tx failed: ${JSON.stringify(tx.meta.err)}`;
        continue;
      }
      const events = [...this.parser.parseLogs(tx.meta.logMessages ?? [])].map((e) => ({
        name: e.name,
        data: e.data as Record<string, unknown>,
      }));
      if (events.length) return { callbackTx: sig, events };
    }
    return { error: firstError ?? `no transaction on the computation account carries a ${this.cfg.programId.toBase58()} event` };
  }

  /** CU of the circuit (from its comp def, cached) and this computation's execution fee. */
  private async readFees(
    circuit: string,
    account: string
  ): Promise<Pick<ComputationRun, "cuAmount" | "baseFeeLamports" | "priorityFeeLamports">> {
    const out: Pick<ComputationRun, "cuAmount" | "baseFeeLamports" | "priorityFeeLamports"> = {};
    const arcium = getArciumProgram(this.provider);
    try {
      let cu = this.cuByCircuit.get(circuit);
      if (!cu) {
        const compDef = getCompDefAccAddress(
          this.cfg.programId,
          Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
        );
        const acc = (await arcium.account.computationDefinitionAccount.fetch(compDef, "confirmed")) as {
          cuAmount: { toString(): string };
        };
        cu = acc.cuAmount.toString();
        this.cuByCircuit.set(circuit, cu);
      }
      out.cuAmount = cu;
    } catch (err) {
      console.warn(`[MXE] could not read CU for ${circuit}: ${String(err)}`);
    }
    try {
      const acc = (await arcium.account.computationAccount.fetch(new PublicKey(account), "confirmed")) as {
        executionFee: { baseFee: { toString(): string }; priorityFee: { toString(): string } };
      };
      out.baseFeeLamports = Number(acc.executionFee.baseFee.toString());
      out.priorityFeeLamports = Number(acc.executionFee.priorityFee.toString());
    } catch (err) {
      console.warn(`[MXE] could not read the execution fee of ${account}: ${String(err)}`);
    }
    return out;
  }

  /** A plain instruction (no computation). Returns the tx and its fee-payer cost. */
  async send(
    method: string,
    args: unknown[],
    accounts: Record<string, PublicKey>
  ): Promise<{ tx: string; lamports: number }> {
    const before = await this.cfg.connection.getBalance(this.authority, "confirmed");
    const tx: string = await (this.program.methods as any)
      [method](...args)
      .accountsPartial({ authority: this.authority, ...accounts })
      .rpc({ commitment: "confirmed" });
    const after = await this.cfg.connection.getBalance(this.authority, "confirmed");
    return { tx, lamports: before - after };
  }

  /** Current cluster time, for RFQ deadlines (`Clock::unix_timestamp`). */
  async clusterTime(): Promise<number> {
    // Not the local clock: a deadline checked against the wrong time would
    // only fail later, inside the program. The newest confirmed slot can be
    // skipped or not yet stored by the RPC ("Block not available for slot",
    // 11/4 F2), so step back a slot and retry; a few slots off is under 2s.
    const slot = await this.cfg.connection.getSlot("confirmed");
    let last: unknown;
    for (let back = 0; back < 6; back++) {
      try {
        const t = await this.cfg.connection.getBlockTime(slot - back);
        if (t !== null) return t;
        last = new Error(`no block time for slot ${slot - back}`);
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`failed to get block time near slot ${slot}: ${String(last)}`);
  }
}

/** A run as it goes into a record's `computations` (no events). */
export function computationEntry(r: ComputationRun) {
  return {
    circuit: r.circuit,
    offset: r.offset,
    account: r.account,
    queueTx: r.queueTx,
    callbackTx: r.callbackTx,
    latencyMs: r.latencyMs,
    lamports: r.lamports,
    cuAmount: r.cuAmount,
    baseFeeLamports: r.baseFeeLamports,
    priorityFeeLamports: r.priorityFeeLamports,
    rentReclaimedLamports: r.rentReclaimedLamports,
  };
}

/** The single event named `name` in a run, or a failure naming what was there. */
export function eventOf(run: ComputationRun, name: string): Record<string, unknown> {
  const e = run.events.find((x) => x.name === name);
  if (!e) {
    throw new ComputationFailed(
      `expected ${name}, callback emitted ${run.events.map((x) => x.name).join(", ") || "nothing"}`,
      run.circuit,
      run.offset,
      run.account,
      run.queueTx
    );
  }
  return e.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
