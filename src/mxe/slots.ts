/**
 * Function 3's scoreboard slots: one per seller, by host. The circuit has a
 * fixed 8 slots; these are the sellers the daily run pays most. A seller not
 * listed is simply not rated.
 */
export const SCOREBOARD_SLOTS: readonly string[] = [
  "osd.x402jp.com",
  "x402oif.vercel.app",
  "x402amd.vercel.app",
  "x402yi.vercel.app",
  "x402-jrey.vercel.app",
  "x402pi.vercel.app",
  "odo-gamma.vercel.app",
  "jin.x402jp.com",
];

/** The slot for an endpoint URL, or undefined when its host has none. */
export function slotFor(url: string): number | undefined {
  try {
    const i = SCOREBOARD_SLOTS.indexOf(new URL(url).host);
    return i >= 0 ? i : undefined;
  } catch {
    return undefined;
  }
}
