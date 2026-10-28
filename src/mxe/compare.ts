/**
 * The public methods each sealed function is compared against (完了条件:
 * functions 1, 2 and 5 each compared at least once).
 *
 * They run on the same inputs, in the clear, and report what they reveal as
 * well as what they decide — the point of the comparison is the difference in
 * disclosure, not only in price or latency.
 */

export interface PublicNegotiation {
  matched: boolean;
  priceMicro: bigint;
  rounds: number;
  /** Every offer made, in order — all of it visible to the other side. */
  offers: { side: "seller" | "buyer"; micro: bigint }[];
}

/**
 * Alternating offers with fixed concessions: the seller opens at twice its
 * floor, the buyer at half its ceiling, and each round each side moves a tenth
 * of the remaining way to its limit. They deal at the midpoint of the first
 * crossing, or not at all once both stand at their limits.
 *
 * The strategy is deliberately plain. What matters for the comparison is that
 * every offer is disclosed, and the last ones bracket each side's limit.
 */
export function publicNegotiation(floorMicro: bigint, ceilingMicro: bigint, maxRounds = 200): PublicNegotiation {
  let ask = floorMicro * 2n;
  let bid = ceilingMicro / 2n;
  const offers: PublicNegotiation["offers"] = [];
  for (let round = 1; round <= maxRounds; round++) {
    offers.push({ side: "seller", micro: ask }, { side: "buyer", micro: bid });
    if (bid >= ask) {
      return { matched: true, priceMicro: (ask + bid) / 2n, rounds: round, offers };
    }
    if (ask === floorMicro && bid === ceilingMicro) break;
    const nextAsk = ask - (ask - floorMicro + 9n) / 10n;
    const nextBid = bid + (ceilingMicro - bid + 9n) / 10n;
    ask = nextAsk < floorMicro ? floorMicro : nextAsk;
    bid = nextBid > ceilingMicro ? ceilingMicro : nextBid;
  }
  return { matched: false, priceMicro: 0n, rounds: offers.length / 2, offers };
}

export interface PublicRfq {
  winner: string;
  priceMicro: bigint;
  /** Every quote, visible to the buyer and to whoever sees the board. */
  quotes: { seller: string; micro: bigint }[];
}

/** Lowest quote wins; ties go to the first, as in the circuit's strict `<`. */
export function publicRfq(quotes: { seller: string; micro: bigint }[]): PublicRfq {
  if (quotes.length === 0) throw new Error("no quotes");
  let best = quotes[0];
  for (const q of quotes.slice(1)) if (q.micro < best.micro) best = q;
  return { winner: best.seller, priceMicro: best.micro, quotes };
}
