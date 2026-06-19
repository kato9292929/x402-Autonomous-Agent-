/**
 * In-memory store for active IDKit requests.
 * Each entry maps requestId → IDKitRequest object (server-side polling).
 * Lost on process restart — approval flow must be restarted if that happens.
 */
import type { IDKitRequest } from "@worldcoin/idkit-core";

const sessions = new Map<string, IDKitRequest>();

export function storeSession(requestId: string, req: IDKitRequest): void {
  sessions.set(requestId, req);
}

export function getSession(requestId: string): IDKitRequest | undefined {
  return sessions.get(requestId);
}

export function deleteSession(requestId: string): void {
  sessions.delete(requestId);
}
