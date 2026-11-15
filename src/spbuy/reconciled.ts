/**
 * Payments found on chain after the run had recorded them as "no transfer".
 *
 * The first live run (2026-11-16 06:00 JST) predates settle-search.ts. Five
 * sellers answered 200 without a settlement header; each transfer below was
 * found afterwards from the AA wallets (Base 0xae7c34…, Solana 7PVToV…) to the
 * seller's payTo, at the call's time and for the quoted amount. The stored run
 * is not rewritten: these are applied when runs are read, as Seller Probe does
 * with its paid_reconciled rows.
 */
import type { SpBuyRecord, SpBuyRun } from "./run";
import { verdictOf } from "./run";

interface Reconciled {
  date: string;
  url: string;
  tx: string;
  network: string;
  amountUsd: number;
}

export const RECONCILED: Reconciled[] = [
  { date: "2026-11-16", url: "https://win.oneshotagent.com/v1/tools/search", tx: "0x84f0d3c5a00a2a370ddace754b4283be919e00849b69b8a53ec38986b2429fb2", network: "eip155:8453", amountUsd: 0.001 },
  { date: "2026-11-16", url: "https://win.oneshotagent.com/v1/tools/web-read", tx: "0x4c47826f32627ad7252480e2b860b1a81c3efba9817727877029907fb114600e", network: "eip155:8453", amountUsd: 0.002 },
  { date: "2026-11-16", url: "https://api.agents-trust.com/recommend", tx: "0x8e09a6f68ed0c3b9fe1cd836b11d6f41f6cb4fd6fc7b0231d0b5d3eb364bc6c3", network: "eip155:8453", amountUsd: 0.01 },
  { date: "2026-11-16", url: "https://glim.sh/api/v1/web/fetch", tx: "4DoSKmguLSLFd4GmQDcUuGkNwm5zfoC32f4Zg2DMYEpvTAoXT77T64nDPF79Scc8BqNwMvX5W3rf7cSVMGojHq3n", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amountUsd: 0.002 },
  { date: "2026-11-16", url: "https://glim.sh/api/v1/twitter/search", tx: "2um1SmEFoqYJMnFyj7tLmiq9vE47GYJ2THV3TMiSQLVGEGcdPHvSL3Tt9rTnvYdgHkYx3BUvSzKHwDQyDMy9hXh7", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amountUsd: 0.005 },
];

const urlKey = (u: string) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
};

/** A run with the reconciled transfers laid over its records. */
export function applyReconciled(run: SpBuyRun, list: Reconciled[] = RECONCILED): SpBuyRun {
  const mine = list.filter((r) => r.date === run.date);
  if (!mine.length) return run;
  let added = 0;
  const records = run.records.map((rec): SpBuyRecord => {
    if (rec.tx) return rec;
    const hit = mine.find((m) => urlKey(m.url) === urlKey(rec.url));
    if (!hit) return rec;
    added += hit.amountUsd;
    const v = verdictOf({ status: rec.http_status ?? 0, tx: hit.tx, bodyLength: rec.response_bytes ?? 0, checks: rec.checks });
    return {
      ...rec,
      tx: hit.tx,
      tx_source: "onchain_search",
      network: hit.network,
      amount_usd: hit.amountUsd,
      verdict: v.verdict,
      verdict_reason: `${v.reason} (settlement header missing; transfer found on chain afterwards)`,
      disagrees: v.verdict !== "as_described",
    };
  });
  return { ...run, records, spentUsd: run.spentUsd + added };
}
