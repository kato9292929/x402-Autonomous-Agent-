/**
 * Returns the rent still held by computation accounts from earlier runs.
 *
 * Every computation leaves a rent deposit (≈ 0.003–0.008 devnet SOL) in its
 * computation account. Finalized ones can be claimed back at once; ones the
 * cluster never executed (11/6– when Arcium devnet stopped executing) can be
 * reclaimed only after Arcium counts them as expired, so they are retried on
 * every run until that happens. Runs at the start of each MXE job.
 */
import * as anchor from "@anchor-lang/core";
import type { MxeChain } from "./chain";
import type { MxeTradeRecord } from "./record";
import { upstashCommand, upstashConfigured } from "../store/upstash-rest";

export interface RentSweep {
  at: string;
  checked: number;
  claimed: number;
  claimedLamports: number;
  /** Never executed and not yet expired: their rent stays locked for now. */
  stillQueued: number;
  stillQueuedLamports: number;
  errors: string[];
}

const KEY = "mxe_rent_sweeps";

/** Offsets of every computation the records name, from the last `days` days. */
export function offsetsOf(records: MxeTradeRecord[], days = 30): string[] {
  const since = Date.now() - days * 86_400_000;
  const out = new Set<string>();
  for (const r of records) {
    if (Date.parse(r.at) < since || r.network !== "arcium-devnet") continue;
    for (const c of r.computations ?? []) if (c.offset) out.add(c.offset);
    if (r.computationOffset) out.add(r.computationOffset);
  }
  return [...out];
}

export async function sweepRent(chain: MxeChain, records: MxeTradeRecord[]): Promise<RentSweep> {
  const sweep: RentSweep = { at: new Date().toISOString(), checked: 0, claimed: 0, claimedLamports: 0, stillQueued: 0, stillQueuedLamports: 0, errors: [] };
  for (const off of offsetsOf(records)) {
    const offset = new anchor.BN(off);
    let status: string | undefined;
    try {
      status = await chain.computationStatus(offset);
    } catch (err) {
      sweep.errors.push(`${off}: status ${String(err).slice(0, 120)}`);
      continue;
    }
    if (!status) continue; // already closed
    sweep.checked++;
    try {
      const lamports = status === "queued" ? await chain.reclaimExpired(offset) : await chain.claimRent(offset);
      sweep.claimed++;
      sweep.claimedLamports += lamports;
    } catch (err) {
      const msg = String(err);
      if (/6210|ComputationNotExpired/.test(msg)) {
        sweep.stillQueued++;
        const info = await chain.cfg.connection.getAccountInfo(
          (await import("@arcium-hq/client")).getComputationAccAddress(chain.cfg.clusterOffset, offset),
          "confirmed"
        );
        sweep.stillQueuedLamports += info?.lamports ?? 0;
      } else {
        sweep.errors.push(`${off} (${status}): ${msg.slice(0, 160)}`);
      }
    }
  }
  if (upstashConfigured()) {
    try {
      await upstashCommand(["LPUSH", KEY, JSON.stringify(sweep)]);
      await upstashCommand(["LTRIM", KEY, 0, 59]);
    } catch (err) {
      console.error(`[MXE] rent sweep save failed: ${String(err)}`);
    }
  }
  return sweep;
}

export async function lastRentSweep(): Promise<RentSweep | undefined> {
  if (!upstashConfigured()) return undefined;
  try {
    const raw = await upstashCommand<string[]>(["LRANGE", KEY, 0, 0]);
    return Array.isArray(raw) && raw[0] ? (JSON.parse(raw[0]) as RentSweep) : undefined;
  } catch {
    return undefined;
  }
}
