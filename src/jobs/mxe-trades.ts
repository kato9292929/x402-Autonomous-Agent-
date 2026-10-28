/**
 * The MXE job: runs each enabled function once on the Arcium cluster, settles
 * the internal trades over x402 on Solana mainnet, runs the public method beside
 * it, and appends one record per function to `mxe_trades`.
 *
 * It stands beside the existing flows, never inside them: its own schedule
 * (daily 07:30 JST, after the 06:00 run), its own flags, nothing it touches is
 * read by dailyRun. With the MXE unreachable each enabled function is recorded
 * as failed, with the error, and nothing else changes — there is no mock to
 * fall back to and no result is filled in.
 *
 * Internal agents (functions 1, 2, 4) are the AA's own wallets on both sides.
 * Their valuations are drawn per run from small ranges; the records say so
 * (counterparty "internal") and they are not evidence of outside demand.
 */
import * as http from "http";
import { randomInt } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { MxeChain, ComputationFailed, type ComputationRun } from "../mxe/chain";
import {
  CATALOG_SIZES,
  jointPurchase,
  negotiate,
  openScoreboard,
  plainSearch,
  revealScores,
  sealedRfq,
  sealedSearch,
  setCatalog,
  submitRating,
  type MxeOutcome,
} from "../mxe/functions";
import { publicNegotiation, publicRfq } from "../mxe/compare";
import { catalogOf, catalogVersion, knownEndpoints, queryFor } from "../mxe/catalog";
import { CLUSTER_OFFSET, functionEnabled, mxeNetwork, mxeProgramId } from "../mxe/flags";
import { hydrateAgentWallets } from "../mxe/wallets";
import { devnetQueuerFromEnv } from "../mxe/wallet";
import { agentWallet, payInternal, type AgentWallet, type Payment } from "../mxe/buyer";
import { handleMxeSell, openTrade, SELL_PREFIX, SOLANA_MAINNET } from "../mxe/seller";
import { DEVNET_USD_BASIS, MAINNET_USD_BASIS, solUsd } from "../mxe/price";
import {
  INTERNAL_FUNCTIONS,
  MXE_FUNCTION_LABELS,
  unitCostRatio,
  type Counterparty,
  type MxeFunction,
  type MxeNetwork,
  type MxeTradeRecord,
} from "../mxe/record";
import { saveMxeRecord } from "../store/mxe-store";
import { loadProbeRuns } from "../store/probe-store";
import { loadRuns } from "../store/run-store";
import { upstashCommand, upstashConfigured } from "../store/upstash-rest";
import { SCOREBOARD_SLOTS, slotFor } from "../mxe/slots";

const SCOREBOARD_KEY = "mxe_scoreboard_id";

/** Devnet RPC: MXE_RPC_URL, else the Helius key from SOLANA_RPC_URL pointed at devnet, else the public one. */
export function devnetRpcUrl(env = process.env): string {
  if (env.MXE_RPC_URL) return env.MXE_RPC_URL;
  const main = env.SOLANA_RPC_URL;
  if (main && main.includes("mainnet.helius-rpc.com")) return main.replace("mainnet.helius-rpc.com", "devnet.helius-rpc.com");
  return "https://api.devnet.solana.com";
}

export function buildChain(env = process.env): MxeChain {
  const network = mxeNetwork(env);
  if (network === "arcium-localnet") throw new Error("the job does not run against localnet");
  const programId = mxeProgramId(env);
  if (!programId) throw new Error("MXE_PROGRAM_ID is not set, and there is no default outside devnet");
  if (network === "arcium-mainnet") {
    throw new Error("arcium-mainnet is not wired: the payer and RPC here are devnet-only");
  }
  const q = devnetQueuerFromEnv(env);
  if ("missing" in q) throw new Error(`devnet signer not configured: ${q.missing.join(", ")}`);
  return new MxeChain({
    connection: new Connection(devnetRpcUrl(env), "confirmed"),
    wallet: q.wallet,
    programId: new PublicKey(programId),
    clusterOffset: CLUSTER_OFFSET[network],
  });
}

/** A draw in [lo, hi] micro-USDC. */
const draw = (lo: number, hi: number) => BigInt(randomInt(lo, hi + 1));

interface Ctx {
  chain: MxeChain;
  network: MxeNetwork;
  solUsd?: number;
  sellBase: string;
  /** USDC paid so far in this run, for the per-run ceiling. */
  runSpentUsd: number;
}

/** The parts every record shares, from the computations a function ran. */
function measured(ctx: Ctx, out: MxeOutcome<unknown>): Partial<MxeTradeRecord> {
  const last = out.runs[out.runs.length - 1];
  const costSol = out.lamports / 1e9;
  return {
    network: ctx.network,
    computations: out.runs.map((r) => ({
      circuit: r.circuit,
      offset: r.offset,
      account: r.account,
      queueTx: r.queueTx,
      callbackTx: r.callbackTx,
      latencyMs: r.latencyMs,
    })),
    computationOffset: last?.offset,
    computationAccount: last?.account,
    queueTx: last?.queueTx,
    latencyMs: out.latencyMs,
    costSol,
    // costArcium stays unset: Arcium 0.15 takes its computation fee in SOL
    // (inside costSol), and no separate token balance is read here.
    solUsd: ctx.solUsd,
    costUsd: ctx.solUsd !== undefined ? costSol * ctx.solUsd : undefined,
    costUsdBasis: ctx.solUsd !== undefined ? (ctx.network === "arcium-devnet" ? DEVNET_USD_BASIS : MAINNET_USD_BASIS) : undefined,
  };
}

function baseRecord(fn: MxeFunction, network: MxeNetwork, counterparty: Counterparty): MxeTradeRecord {
  return {
    at: new Date().toISOString(),
    fn,
    label: MXE_FUNCTION_LABELS[fn],
    status: "failed",
    network,
    counterparty,
  };
}

/** A failure record: the computation id only if one was really queued. */
function failed(rec: MxeTradeRecord, err: unknown, runsSoFar: ComputationRun[] = []): MxeTradeRecord {
  const out: MxeTradeRecord = { ...rec, status: "failed", error: err instanceof Error ? err.message : String(err) };
  if (err instanceof ComputationFailed) {
    out.computationOffset = err.offset;
    out.computationAccount = err.account;
    out.queueTx = err.queueTx;
  }
  if (runsSoFar.length) out.computations = runsSoFar.map((r) => ({ circuit: r.circuit, offset: r.offset, account: r.account, queueTx: r.queueTx, callbackTx: r.callbackTx, latencyMs: r.latencyMs }));
  return out;
}

async function pay(ctx: Ctx, fn: 1 | 2 | 4, buyer: AgentWallet, seller: AgentWallet, micro: bigint, product: unknown): Promise<Payment> {
  const trade = openTrade({ fn, payTo: seller.address, priceMicro: micro, product });
  const p = await payInternal(buyer, `${ctx.sellBase}${SELL_PREFIX}${trade.id}`, micro, seller.address, ctx.runSpentUsd);
  if (p.ok) ctx.runSpentUsd += Number(micro) / 1e6;
  return p;
}

function withTrade(rec: MxeTradeRecord, payments: Payment[], tradeMicro: bigint): MxeTradeRecord {
  const paid = payments.filter((p) => p.ok);
  const tradeUsd = Number(tradeMicro) / 1e6;
  const out: MxeTradeRecord = {
    ...rec,
    paymentNetwork: SOLANA_MAINNET,
    paymentTxs: paid.map((p) => p.tx!).filter(Boolean),
    tradeUsd: paid.length ? tradeUsd : undefined,
  };
  out.unitCostRatio = unitCostRatio(out.costUsd, out.tradeUsd);
  const bad = payments.filter((p) => !p.ok);
  if (bad.length) {
    out.status = "failed";
    out.error = `payment failed: ${bad.map((p) => p.error).join("; ")}`;
  }
  return out;
}

async function productOfTheDay(): Promise<unknown> {
  const [last] = await loadRuns(1);
  return last
    ? { kind: "aa-daily-run-summary", at: last.timestamp, mode: last.mode, costUsdc: last.totalCostUsdc, txCount: last.totalTxCount }
    : { kind: "aa-daily-run-summary", at: null };
}

// ── the five functions ────────────────────────────────────────────────────

async function runF1(ctx: Ctx): Promise<MxeTradeRecord> {
  const rec = baseRecord(1, ctx.network, "internal");
  const seller = agentWallet("SELLER_A");
  const buyer = agentWallet("BUYER_A");
  if (!seller || !buyer) return failed(rec, "CIRCLE_MXE_SELLER_A / BUYER_A wallets not configured");
  const floor = draw(2_000, 6_000);
  const ceiling = draw(3_000, 9_000);
  try {
    const t = Date.now();
    const pub = publicNegotiation(floor, ceiling);
    const pubMs = Date.now() - t;
    const out = await negotiate(ctx.chain, floor, ceiling);
    let r: MxeTradeRecord = {
      ...rec,
      ...measured(ctx, out),
      status: "ok",
      result: { matched: out.result.matched, priceMicro: out.result.priceMicro.toString(), revealed: ["matched", "price"] },
      comparison: {
        method: "public alternating offers (10% concessions)",
        result: { matched: pub.matched, priceMicro: pub.priceMicro.toString(), rounds: pub.rounds },
        latencyMs: pubMs,
        disclosed: [`${pub.offers.length} offers, the last of which bracket each side's limit`],
      },
    };
    if (out.result.matched) {
      const p = await pay(ctx, 1, buyer, seller, out.result.priceMicro, await productOfTheDay());
      r = withTrade(r, [p], out.result.priceMicro);
    }
    return r;
  } catch (err) {
    return failed(rec, err);
  }
}

async function runF2(ctx: Ctx): Promise<MxeTradeRecord> {
  const rec = baseRecord(2, ctx.network, "internal");
  const a = agentWallet("SELLER_A");
  const b = agentWallet("SELLER_B");
  const buyer = agentWallet("BUYER_A");
  if (!a || !b || !buyer) return failed(rec, "CIRCLE_MXE_SELLER_A / SELLER_B / BUYER_A wallets not configured");
  const quotes = [
    { seller: a, micro: draw(2_000, 9_000) },
    { seller: b, micro: draw(2_000, 9_000) },
  ];
  try {
    const t = Date.now();
    const pub = publicRfq(quotes.map((q) => ({ seller: q.seller.address, micro: q.micro })));
    const pubMs = Date.now() - t;
    // Long enough for each quote to finalize on devnet before the deadline.
    const durationSec = Number(process.env.MXE_RFQ_DURATION_SEC ?? 240);
    const out = await sealedRfq(
      ctx.chain,
      quotes.map((q) => ({ seller: new PublicKey(q.seller.address), amountMicro: q.micro })),
      durationSec
    );
    const winner = [a, b].find((w) => w.address === out.result.winner);
    let r: MxeTradeRecord = {
      ...rec,
      ...measured(ctx, out),
      status: "ok",
      result: { winner: out.result.winner, priceMicro: out.result.priceMicro.toString(), quoteCount: out.result.quoteCount, revealed: ["winner", "price"] },
      comparison: {
        method: "public quotes, lowest wins",
        result: { winner: pub.winner, priceMicro: pub.priceMicro.toString() },
        latencyMs: pubMs,
        disclosed: [`all ${pub.quotes.length} quotes and who made them`],
      },
    };
    if (!winner) return { ...r, status: "failed", error: `winner ${out.result.winner} is not an internal seller` };
    const p = await pay(ctx, 2, buyer, winner, out.result.priceMicro, await productOfTheDay());
    r = withTrade(r, [p], out.result.priceMicro);
    return r;
  } catch (err) {
    return failed(rec, err);
  }
}

/** The scoreboard id already in use (env override, else the one the job opened), if any. */
export async function storedScoreboardId(): Promise<string | undefined> {
  if (process.env.MXE_SCOREBOARD_ID) return process.env.MXE_SCOREBOARD_ID;
  if (!upstashConfigured()) return undefined;
  const v = await upstashCommand<string | null>(["GET", SCOREBOARD_KEY]).catch(() => null);
  return v ?? undefined;
}

/** The scoreboard all ratings go to, opened once and remembered. */
async function scoreboardId(ctx: Ctx): Promise<{ id: string; opened?: MxeOutcome<{ boardId: string }> }> {
  const stored = await storedScoreboardId();
  if (stored) return { id: stored };
  const opened = await openScoreboard(ctx.chain);
  if (upstashConfigured()) await upstashCommand(["SET", SCOREBOARD_KEY, opened.result.boardId]).catch(() => undefined);
  return { id: opened.result.boardId, opened };
}

async function runF3(ctx: Ctx): Promise<MxeTradeRecord> {
  const rec = baseRecord(3, ctx.network, "self");
  try {
    const board = await scoreboardId(ctx);
    // The AA rates each seller its last daily run paid, once, from that run's
    // own results: delivered = a response came back, format_ok = it was not
    // degraded, latency = the call's duration.
    const [last] = await loadRuns(1);
    const runs: ComputationRun[] = [...(board.opened?.runs ?? [])];
    let lamports = board.opened?.lamports ?? 0;
    const rated: { slot: number; seller: string }[] = [];
    for (const res of last?.results ?? []) {
      const slot = slotFor(res.endpoint);
      if (slot === undefined || rated.some((x) => x.slot === slot)) continue;
      const sub = await submitRating(ctx.chain, board.id, {
        slot,
        delivered: res.status !== "error",
        formatOk: res.status === "success",
        latencyMs: res.durationMs,
      });
      runs.push(...sub.runs);
      lamports += sub.lamports;
      rated.push({ slot, seller: SCOREBOARD_SLOTS[slot] });
    }
    const rev = await revealScores(ctx.chain, board.id);
    runs.push(...rev.runs);
    lamports += rev.lamports;
    const all: MxeOutcome<unknown> = { result: null, runs, latencyMs: runs.reduce((a, r) => a + r.latencyMs, 0), lamports };
    return {
      ...rec,
      ...measured(ctx, all),
      status: "ok",
      result: { boardId: board.id, rated, ...rev.result, slots: SCOREBOARD_SLOTS },
    };
  } catch (err) {
    return failed(rec, err);
  }
}

async function runF4(ctx: Ctx): Promise<MxeTradeRecord> {
  const rec = baseRecord(4, ctx.network, "internal");
  const seller = agentWallet("SELLER_A");
  const buyers = [agentWallet("BUYER_A"), agentWallet("BUYER_B")];
  if (!seller || buyers.some((b) => !b)) return failed(rec, "CIRCLE_MXE_SELLER_A / BUYER_A / BUYER_B wallets not configured");
  const price = draw(4_000, 8_000);
  // The third slot is a non-participant (cap 0): the circuit always takes three.
  const caps = [draw(1_000, 6_000), draw(1_000, 6_000), 0n];
  try {
    const out = await jointPurchase(ctx.chain, caps, price);
    let r: MxeTradeRecord = {
      ...rec,
      ...measured(ctx, out),
      status: "ok",
      result: { reached: out.result.reached, priceMicro: price.toString(), revealed: ["reached"], participants: caps.filter((c) => c > 0n).length },
    };
    if (out.result.reached) {
      const product = await productOfTheDay();
      const payments: Payment[] = [];
      for (const [i, share] of out.result.sharesMicro.entries()) {
        if (share === 0n) continue;
        payments.push(await pay(ctx, 4, buyers[i]!, seller, share, product));
      }
      const total = out.result.sharesMicro.reduce((s, x) => s + x, 0n);
      r = withTrade(r, payments, total);
    }
    return r;
  } catch (err) {
    return failed(rec, err);
  }
}

async function runF5(ctx: Ctx): Promise<MxeTradeRecord[]> {
  const known = knownEndpoints(await loadProbeRuns(20));
  const q = queryFor();
  const records: MxeTradeRecord[] = [];
  for (const size of CATALOG_SIZES) {
    const rec = baseRecord(5, ctx.network, "self");
    try {
      const entries = catalogOf(size, known);
      const set = await setCatalog(ctx.chain, size, catalogVersion(entries), entries);
      const t = process.hrtime.bigint();
      const plain = plainSearch(entries, q);
      const plainUs = Number(process.hrtime.bigint() - t) / 1000;
      const out = await sealedSearch(ctx.chain, size, q);
      const same = JSON.stringify(out.result.matches) === JSON.stringify(plain);
      const m = measured(ctx, { ...out, lamports: out.lamports + set.lamports });
      records.push({
        ...rec,
        ...m,
        status: same ? "ok" : "failed",
        error: same ? undefined : "sealed and plain searches disagree",
        result: { catalogSize: size, matches: out.result.matches.map((i) => entries[i].id), query: q },
        comparison: {
          method: "plain filter over the same catalog",
          result: { matches: plain.map((i) => entries[i].id) },
          latencyMs: plainUs / 1000,
          disclosed: ["the query itself, to whoever runs the search"],
        },
      });
    } catch (err) {
      records.push(failed(rec, err));
    }
  }
  return records;
}

/** A local server for the internal sellers, alive for the run only. */
async function withSellerServer<T>(f: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    void handleMxeSell(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await f(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

export async function runMxeJob(): Promise<MxeTradeRecord[]> {
  const fns = ([1, 2, 3, 4, 5] as MxeFunction[]).filter((fn) => functionEnabled(fn));
  if (fns.length === 0) {
    console.log("[MXE] no function enabled (MXE_F1_ENABLED … MXE_F5_ENABLED)");
    return [];
  }
  const network = mxeNetwork();
  // Agent wallets come from Circle by refId unless set explicitly.
  for (const note of await hydrateAgentWallets()) console.log(`[MXE] wallet ${note}`);
  let chain: MxeChain;
  try {
    chain = buildChain();
  } catch (err) {
    // The MXE is unavailable: say so per function, and do nothing else.
    const records = fns.map((fn) =>
      failed(baseRecord(fn, network, INTERNAL_FUNCTIONS.has(fn) ? "internal" : "self"), `MXE unavailable: ${String(err)}`)
    );
    for (const r of records) await saveMxeRecord(r);
    console.error(`[MXE] unavailable — ${records.length} function(s) recorded as failed: ${String(err)}`);
    return records;
  }

  return withSellerServer(async (sellBase) => {
    const ctx: Ctx = { chain, network, solUsd: await solUsd(), sellBase, runSpentUsd: 0 };
    const records: MxeTradeRecord[] = [];
    const runners: Record<MxeFunction, () => Promise<MxeTradeRecord | MxeTradeRecord[]>> = {
      1: () => runF1(ctx),
      2: () => runF2(ctx),
      3: () => runF3(ctx),
      4: () => runF4(ctx),
      5: () => runF5(ctx),
    };
    for (const fn of fns) {
      console.log(`[MXE] function ${fn} — ${MXE_FUNCTION_LABELS[fn]}`);
      const out = await runners[fn]();
      for (const r of Array.isArray(out) ? out : [out]) {
        await saveMxeRecord(r);
        records.push(r);
        console.log(
          `[MXE]   ${r.status}${r.computationOffset ? ` comp ${r.computationOffset}` : ""}` +
            `${r.latencyMs !== undefined ? ` ${r.latencyMs} ms` : ""}${r.costSol !== undefined ? ` ${r.costSol.toFixed(6)} SOL` : ""}` +
            `${r.error ? ` — ${r.error}` : ""}`
        );
      }
    }
    return records;
  });
}
