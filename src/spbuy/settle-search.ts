/**
 * Finds a payment on chain when the seller answered without a settlement header.
 *
 * Some sellers return 200 with the body but no PAYMENT-RESPONSE /
 * X-PAYMENT-RESPONSE. The first live run (2026-11-16 06:00 JST) recorded five
 * such calls as "no transfer" although each had moved USDC: win.oneshotagent.com
 * (×2) and api.agents-trust.com on Base, glim.sh (×2) on Solana. Seller Probe
 * handles the same case by looking for its own signature on chain
 * (seller-probe README, "決済の応答ヘッダが無いとき"); this does the same:
 *
 *   Base   the EIP-3009 authorization we signed carries a random nonce; USDC emits
 *          AuthorizationUsed(authorizer, nonce) when it is spent.
 *   Solana the transaction we partially signed carries our signature; the landed
 *          transaction carries it too, so it is matched among our wallet's
 *          recent transactions.
 */
import { base58 } from "@scure/base";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** keccak256("AuthorizationUsed(address,bytes32)") */
const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

export const baseRpc = () => process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
export const solanaRpc = () => process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export type SentPayment =
  | { chain: "base"; from: string; nonce: string }
  | { chain: "solana"; payer: string | null; signatures: string[] };

/** What we signed, read from the payment header we sent (v2 PAYMENT-SIGNATURE, v1 X-PAYMENT). */
export function sentPaymentFromHeader(header: string | null | undefined, payer?: string): SentPayment | null {
  if (!header) return null;
  let doc: any;
  try {
    doc = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const p = doc?.payload;
  const auth = p?.authorization;
  if (auth && typeof auth.from === "string" && typeof auth.nonce === "string") {
    return { chain: "base", from: auth.from, nonce: auth.nonce };
  }
  if (typeof p?.transaction === "string") {
    return { chain: "solana", payer: payer ?? null, signatures: signaturesOfWireTx(Buffer.from(p.transaction, "base64")) };
  }
  return null;
}

/** Non-empty signatures of a serialized Solana transaction (the fee payer's slot is empty until it signs). */
export function signaturesOfWireTx(tx: Buffer): string[] {
  // compact-u16 count, then 64-byte signatures
  let n = 0;
  let shift = 0;
  let i = 0;
  for (; i < 3; i++) {
    const b = tx[i];
    n |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) { i++; break; }
  }
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const sig = tx.subarray(i + 64 * k, i + 64 * (k + 1));
    if (sig.length === 64 && sig.some((x) => x !== 0)) out.push(base58.encode(sig));
  }
  return out;
}

async function rpc(url: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<any> {
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

const pad32 = (hex: string) => "0x" + hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** The landed transaction for what we signed, or null when none is found. */
export async function findSettlement(
  sent: SentPayment,
  opts: { fetchImpl?: typeof fetch; tries?: number; waitMs?: number; lookbackBlocks?: number } = {}
): Promise<{ tx: string; source: "onchain_search" } | null> {
  const f = opts.fetchImpl ?? fetch;
  const tries = opts.tries ?? 4;
  for (let t = 0; t < tries; t++) {
    try {
      if (sent.chain === "base") {
        const head = parseInt(await rpc(baseRpc(), "eth_blockNumber", [], f), 16);
        const logs: any[] = await rpc(
          baseRpc(),
          "eth_getLogs",
          [{ address: BASE_USDC, fromBlock: "0x" + Math.max(0, head - (opts.lookbackBlocks ?? 900)).toString(16), toBlock: "latest", topics: [AUTHORIZATION_USED, pad32(sent.from), pad32(sent.nonce)] }],
          f
        );
        if (logs.length) return { tx: logs[0].transactionHash, source: "onchain_search" };
      } else if (sent.payer && sent.signatures.length) {
        const sigs: any[] = await rpc(solanaRpc(), "getSignaturesForAddress", [sent.payer, { limit: 20 }], f);
        const ours = new Set(sent.signatures);
        for (const s of sigs) {
          if (s.err) continue;
          const tx = await rpc(solanaRpc(), "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }], f);
          if ((tx?.transaction?.signatures ?? []).some((x: string) => ours.has(x))) return { tx: s.signature, source: "onchain_search" };
        }
      }
    } catch {
      /* try again */
    }
    if (t < tries - 1) await new Promise((r) => setTimeout(r, opts.waitMs ?? 4000));
  }
  return null;
}
