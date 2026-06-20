import * as fs from "fs";
import * as path from "path";
import type { NullifierStore } from "./types";

const STORE_PATH = path.join(process.cwd(), "data", "used-nullifiers.json");

function load(): NullifierStore {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as NullifierStore;
  } catch {
    return { entries: [] };
  }
}

function save(store: NullifierStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function isNullifierUsed(nullifier: string, action: string): boolean {
  const store = load();
  return store.entries.some((e) => e.nullifier === nullifier && e.action === action);
}

export function recordNullifier(nullifier: string, action: string): void {
  const store = load();
  store.entries.push({ nullifier, action, usedAt: new Date().toISOString() });
  save(store);
}
