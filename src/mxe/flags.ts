/**
 * Per-function switches for the MXE integration (指示書: 機能ごとの有効化フラグ).
 *
 * Off by default, each on its own: MXE_F1_ENABLED … MXE_F5_ENABLED = "true".
 * MXE_ENABLED is the master switch for the scheduled job; with it off nothing
 * MXE-related runs, and the existing flows are untouched either way — the MXE
 * job sits beside dailyRun, never inside it.
 */
import type { MxeFunction, MxeNetwork } from "./record";

export function mxeJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MXE_ENABLED === "true";
}

export function functionEnabled(fn: MxeFunction, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[`MXE_F${fn}_ENABLED`] === "true";
}

/**
 * Which Arcium cluster computations go to. Devnet until a mainnet deploy is
 * confirmed possible; the value is recorded on every row.
 */
export function mxeNetwork(env: NodeJS.ProcessEnv = process.env): MxeNetwork {
  const v = env.MXE_NETWORK?.trim() || "arcium-devnet";
  if (v === "arcium-devnet" || v === "arcium-mainnet" || v === "arcium-localnet") return v;
  throw new Error(`MXE_NETWORK must be arcium-devnet, arcium-mainnet or arcium-localnet (got ${JSON.stringify(v)})`);
}

/** Arcium cluster offsets (docs: devnet 456, mainnet 2026). */
export const CLUSTER_OFFSET: Record<Exclude<MxeNetwork, "arcium-localnet">, number> = {
  "arcium-devnet": 456,
  "arcium-mainnet": 2026,
};
