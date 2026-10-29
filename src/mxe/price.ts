/**
 * SOL/USD, for pricing a computation's SOL cost.
 *
 * Read from Coinbase's public spot endpoint at run time. If it cannot be read
 * the cost stays in SOL only and `costUsd` is left out — a guessed price would
 * turn every 単価比 after it into fiction.
 */
export async function solUsd(fetchFn: typeof fetch = fetch): Promise<number | undefined> {
  try {
    const res = await fetchFn("https://api.coinbase.com/v2/prices/SOL-USD/spot", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data?: { amount?: string } };
    const v = Number(j.data?.amount);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** How a devnet SOL cost is turned into dollars, written on each record. */
export const DEVNET_USD_BASIS =
  "devnet SOL has no market value; priced at the mainnet SOL/USD spot (Coinbase) as an estimate of the same work on mainnet";
export const MAINNET_USD_BASIS = "mainnet SOL/USD spot (Coinbase) at run time";
