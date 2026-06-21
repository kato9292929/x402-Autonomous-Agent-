import * as fs from "fs";
import * as path from "path";
import type { NullifierStore } from "./types";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";

/**
 * Nullifier replay protection: enforces UNIQUE (nullifier, action) so the same
 * person cannot approve the same action twice.
 *
 * With Upstash this is a single atomic SET ... NX on world_nullifier:{action}:
 * {nullifier} — claim and check in one race-free operation (no check-then-set
 * window). Persisting in Upstash also survives redeploys, unlike the previous
 * local data/used-nullifiers.json (kept as a fallback for local dev).
 */

const STORE_PATH = path.join(process.cwd(), "data", "used-nullifiers.json");
const nullifierKey = (action: string, nullifier: string): string =>
  `world_nullifier:${action}:${nullifier}`;
// Actions are single-use (unique per approval id); 30d is well past any action's life.
const NULLIFIER_TTL_SECONDS = 30 * 24 * 60 * 60;

function loadFile(): NullifierStore {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as NullifierStore;
  } catch {
    return { entries: [] };
  }
}

function saveFile(store: NullifierStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Atomically claim a (nullifier, action) pair.
 * Returns true if newly claimed (not used before → allow), false if it was
 * already used (→ reject as a replay / double-approval).
 */
export async function claimNullifier(nullifier: string, action: string): Promise<boolean> {
  if (upstashConfigured()) {
    // SET NX returns "OK" when created, null when the key already existed.
    const res = await upstashCommand<string | null>([
      "SET", nullifierKey(action, nullifier), new Date().toISOString(),
      "NX", "EX", String(NULLIFIER_TTL_SECONDS),
    ]);
    return res === "OK";
  }
  // Local dev fallback (single process): check-then-set is sufficient here.
  const store = loadFile();
  if (store.entries.some((e) => e.nullifier === nullifier && e.action === action)) {
    return false;
  }
  store.entries.push({ nullifier, action, usedAt: new Date().toISOString() });
  saveFile(store);
  return true;
}
