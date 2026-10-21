/**
 * The AA's internal seller agents (functions 1, 2, 4: 内部取引).
 *
 * A sealed computation decides a price; the trade is then settled the ordinary
 * way, over x402 on Solana mainnet: the buyer agent requests
 * `GET /mxe/sell/<tradeId>`, gets a 402 for exactly the decided amount payable
 * to the seller agent's wallet, pays it, and receives the product. PayAI
 * verifies and settles, as it does for onchain-stock-data — with the API key,
 * not the shared free lane that ran out on 2026-10-08.
 *
 * "判定は devnet、支払いは mainnet": the decision is on the Arcium cluster, the
 * money moves on mainnet, and the record keeps the two apart.
 *
 * A trade exists only between `openTrade` and its expiry, in memory. A restart
 * in between loses it; the buyer then gets a 404 and the run records a
 * failure — never a payment that did not happen.
 */
import type * as http from "http";
import { randomBytes } from "crypto";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import type { HTTPAdapter, HTTPRequestContext } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createFacilitatorConfig } from "@payai/facilitator";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SELL_PREFIX = "/mxe/sell/";
const TRADE_TTL_MS = 10 * 60_000;

export interface InternalTrade {
  id: string;
  fn: 1 | 2 | 4;
  /** Seller agent's Solana address (a Circle LIVE wallet). */
  payTo: string;
  priceMicro: bigint;
  /** What the buyer receives once paid. */
  product: unknown;
  expiresAt: number;
  settled?: { tx?: string; payer?: string };
}

const trades = new Map<string, InternalTrade>();

export function openTrade(t: Omit<InternalTrade, "id" | "expiresAt">): InternalTrade {
  if (t.priceMicro <= 0n) throw new Error("an internal trade needs a positive price");
  const trade = { ...t, id: randomBytes(12).toString("hex"), expiresAt: Date.now() + TRADE_TTL_MS };
  trades.set(trade.id, trade);
  return trade;
}

export function getTrade(id: string): InternalTrade | undefined {
  const t = trades.get(id);
  if (t && t.expiresAt < Date.now()) {
    trades.delete(id);
    return undefined;
  }
  return t;
}

function tradeIdOf(path: string): string {
  return path.startsWith(SELL_PREFIX) ? path.slice(SELL_PREFIX.length).split("/")[0] : "";
}

let httpServer: x402HTTPResourceServer | undefined;
let ready: Promise<void> | undefined;

/** The x402 resource server, built and initialized once (asks PayAI what it supports). */
function server(): Promise<x402HTTPResourceServer> {
  if (!ready) {
    if (!process.env.PAYAI_API_KEY_ID || !process.env.PAYAI_API_KEY_SECRET) {
      // Not a fallback to the free lane: an internal trade that cannot settle
      // properly should fail visibly, the way the 10/08 outage should have.
      ready = Promise.reject(
        new Error("PAYAI_API_KEY_ID / PAYAI_API_KEY_SECRET are not set — internal trades do not settle on the free tier")
      );
    } else {
      const facilitator = new HTTPFacilitatorClient(
        createFacilitatorConfig(process.env.PAYAI_API_KEY_ID, process.env.PAYAI_API_KEY_SECRET)
      );
      const rs = new x402ResourceServer([facilitator]);
      // @x402/svm 2.15 carries its own @x402/core; the scheme object is the
      // same shape, so it is registered directly rather than through its helper.
      rs.register(SOLANA_MAINNET, new ExactSvmScheme() as never);
      const routes = {
        [`GET ${SELL_PREFIX}*`]: {
          accepts: {
            scheme: "exact",
            network: SOLANA_MAINNET,
            payTo: (ctx: HTTPRequestContext) => getTrade(tradeIdOf(ctx.path))?.payTo ?? "",
            price: (ctx: HTTPRequestContext) => ({
              asset: SOLANA_USDC_MINT,
              amount: String(getTrade(tradeIdOf(ctx.path))?.priceMicro ?? 0n),
            }),
            maxTimeoutSeconds: 120,
          },
          description: "AA internal trade, priced by an Arcium MXE computation",
          mimeType: "application/json",
        },
      };
      httpServer = new x402HTTPResourceServer(rs, routes as never);
      ready = httpServer.initialize();
    }
  }
  return ready.then(() => httpServer!);
}

function adapterFor(req: http.IncomingMessage): HTTPAdapter {
  const url = new URL(req.url ?? "/", "http://localhost");
  const header = (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    getHeader: header,
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => header("accept") ?? "",
    getUserAgent: () => header("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams),
    getQueryParam: (n: string) => url.searchParams.get(n) ?? undefined,
  };
}

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
}

/** Handles `GET /mxe/sell/<id>`. Returns false for any other path. */
export async function handleMxeSell(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const adapter = adapterFor(req);
  const path = adapter.getPath();
  if (!path.startsWith(SELL_PREFIX)) return false;

  const trade = getTrade(tradeIdOf(path));
  if (!trade || req.method !== "GET") {
    send(res, 404, {}, { error: "no such open trade" });
    return true;
  }
  if (trade.settled) {
    send(res, 409, {}, { error: "trade already settled" });
    return true;
  }

  let s: x402HTTPResourceServer;
  try {
    s = await server();
  } catch (err) {
    send(res, 503, { "Retry-After": "60" }, { error: "payment_unavailable", reason: String(err) });
    return true;
  }

  const ctx: HTTPRequestContext = { adapter, path, method: "GET" };
  const result = await s.processHTTPRequest(ctx);
  if (result.type === "payment-error") {
    send(res, result.response.status, result.response.headers, result.response.body);
    return true;
  }
  if (result.type !== "payment-verified") {
    send(res, 500, {}, { error: "route unexpectedly unpaid" });
    return true;
  }

  const settle = await s.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
    request: ctx,
  });
  if (!settle.success) {
    // A failed settlement is the seller's problem, not a fresh challenge: say
    // 503 with the facilitator's reason (onchain-stock-data#63).
    send(res, 503, { "Retry-After": "60" }, { error: "payment_unavailable", reason: settle.errorReason });
    return true;
  }
  trade.settled = { tx: settle.transaction, payer: settle.payer };
  send(res, 200, settle.headers, { tradeId: trade.id, fn: trade.fn, product: trade.product });
  return true;
}
