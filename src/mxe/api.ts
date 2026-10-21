/**
 * HTTP surface of the MXE integration, mounted by server.ts:
 *
 *   GET  /api/mxe                 records (newest first) and per-function aggregates
 *   GET  /api/mxe/ratings/info    what an evaluator needs to seal a rating
 *   POST /api/mxe/ratings         function 3's 受付口: relay one sealed rating
 *
 * The intake takes ciphertext only. An evaluator encrypts its rating to the
 * MXE's x25519 key on its own machine (field order in /info), so the AA relays
 * a rating it cannot read, and the scoreboard reveals only per-seller sums.
 * Every accepted rating costs a devnet computation, hence the rate limit.
 */
import type * as http from "http";
import * as anchor from "@anchor-lang/core";
import { deserializeLE } from "@arcium-hq/client";
import { aggregateByFunction, MXE_FUNCTION_LABELS, type MxeFunction, type MxeTradeRecord } from "./record";
import { functionEnabled, mxeJobEnabled, mxeNetwork, CLUSTER_OFFSET } from "./flags";
import { loadMxeRecords, saveMxeRecord } from "../store/mxe-store";
import { RateLimiter, INTAKE_LIMITS } from "./rate-limit";
import { SCOREBOARD_SLOTS } from "./slots";
import { submitSealedRating } from "./functions";
import { ComputationFailed } from "./chain";
import { buildChain, storedScoreboardId } from "../jobs/mxe-trades";

const limiter = new RateLimiter(INTAKE_LIMITS);
const MAX_BODY = 4096;

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...headers });
  res.end(JSON.stringify(body));
}

function clientOf(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const hexBytes = (v: unknown, n: number, what: string): Uint8Array => {
  if (typeof v !== "string" || !/^[0-9a-fA-F]+$/.test(v) || v.length !== n * 2) {
    throw new Error(`${what} must be ${n} bytes as hex`);
  }
  return Uint8Array.from(Buffer.from(v, "hex"));
};

/** Parse and validate a sealed rating body. Exported for tests. */
export function parseSealedRating(raw: string): { cts: number[][]; pubkey: Uint8Array; nonce: Uint8Array } {
  const b = JSON.parse(raw) as { ciphertexts?: unknown; evaluatorPublicKey?: unknown; nonce?: unknown };
  if (!Array.isArray(b.ciphertexts) || b.ciphertexts.length !== 4) throw new Error("ciphertexts must be 4 hex strings");
  return {
    cts: b.ciphertexts.map((c, i) => Array.from(hexBytes(c, 32, `ciphertexts[${i}]`))),
    pubkey: hexBytes(b.evaluatorPublicKey, 32, "evaluatorPublicKey"),
    nonce: hexBytes(b.nonce, 16, "nonce"),
  };
}

let mxeKeyHex: string | undefined;

export async function handleMxeApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/api/mxe" && req.method === "GET") {
    const limit = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("limit") ?? 100);
    const all = await loadMxeRecords();
    const fns = [1, 2, 3, 4, 5] as MxeFunction[];
    json(res, 200, {
      jobEnabled: mxeJobEnabled(),
      functions: fns.map((fn) => ({ fn, label: MXE_FUNCTION_LABELS[fn], enabled: functionEnabled(fn) })),
      aggregates: aggregateByFunction(all),
      records: all.slice(0, Math.min(500, Math.max(1, limit))),
      total: all.length,
    });
    return true;
  }

  if (path === "/api/mxe/ratings/info" && req.method === "GET") {
    const network = mxeNetwork();
    let boardId: string | undefined;
    try {
      boardId = await storedScoreboardId();
      if (!mxeKeyHex && process.env.MXE_PROGRAM_ID) {
        mxeKeyHex = Buffer.from(await buildChain().mxePublicKey()).toString("hex");
      }
    } catch {
      /* reported as missing below */
    }
    json(res, 200, {
      accepting: functionEnabled(3) && Boolean(boardId && mxeKeyHex),
      network,
      clusterOffset: network === "arcium-localnet" ? undefined : CLUSTER_OFFSET[network],
      programId: process.env.MXE_PROGRAM_ID ?? null,
      mxeX25519PublicKey: mxeKeyHex ?? null,
      scoreboardId: boardId ?? null,
      slots: SCOREBOARD_SLOTS,
      cipher: "RescueCipher over x25519(evaluator secret, MXE public key), @arcium-hq/client",
      fieldOrder: ["slot (0-7)", "delivered (0|1)", "format_ok (0|1)", "latency_ms (u32, clamped at 60000)"],
      body: { ciphertexts: "4 × 32-byte hex, in fieldOrder", evaluatorPublicKey: "32-byte hex", nonce: "16-byte hex" },
      limits: INTAKE_LIMITS,
    });
    return true;
  }

  if (path === "/api/mxe/ratings" && req.method === "POST") {
    if (!functionEnabled(3)) {
      json(res, 503, { error: "function 3 is disabled (MXE_F3_ENABLED)" });
      return true;
    }
    let sealed: ReturnType<typeof parseSealedRating>;
    try {
      sealed = parseSealedRating(await readBody(req));
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const gate = limiter.take(clientOf(req));
    if (!gate.ok) {
      json(res, 429, { error: `rate limited (${gate.scope})` }, { "Retry-After": String(gate.retryAfterSec) });
      return true;
    }
    const network = mxeNetwork();
    const rec: MxeTradeRecord = {
      at: new Date().toISOString(),
      fn: 3,
      label: MXE_FUNCTION_LABELS[3],
      status: "failed",
      network,
      counterparty: "external",
    };
    try {
      const boardId = await storedScoreboardId();
      if (!boardId) throw new Error("no scoreboard yet — the MXE job opens it on its first function-3 run");
      const chain = buildChain();
      const nonceArg = new anchor.BN(deserializeLE(sealed.nonce).toString());
      const out = await submitSealedRating(chain, boardId, sealed.cts, sealed.pubkey, nonceArg);
      const run = out.runs[0];
      const ok: MxeTradeRecord = {
        ...rec,
        status: "ok",
        computations: [{ circuit: run.circuit, offset: run.offset, account: run.account, queueTx: run.queueTx, callbackTx: run.callbackTx, latencyMs: run.latencyMs }],
        computationOffset: run.offset,
        computationAccount: run.account,
        queueTx: run.queueTx,
        latencyMs: out.latencyMs,
        costSol: out.lamports / 1e9,
        result: { boardId, ratingCount: out.result.ratingCount, sealedBy: "evaluator" },
      };
      await saveMxeRecord(ok);
      json(res, 202, { computationOffset: run.offset, callbackTx: run.callbackTx, ratingCount: out.result.ratingCount });
    } catch (err) {
      const f: MxeTradeRecord = { ...rec, error: err instanceof Error ? err.message : String(err) };
      if (err instanceof ComputationFailed) {
        f.computationOffset = err.offset;
        f.computationAccount = err.account;
        f.queueTx = err.queueTx;
      }
      await saveMxeRecord(f);
      json(res, 502, { error: f.error, computationOffset: f.computationOffset ?? null });
    }
    return true;
  }

  return false;
}
