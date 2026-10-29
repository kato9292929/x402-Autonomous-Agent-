import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ApprovalQueue, ApprovalQueueItem } from "./types";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";

/**
 * Approval queue persistence.
 *
 * When Upstash is configured each approval lives at world_approval:{id} (JSON),
 * with the id tracked in a world_approvals_index set so listItems() can
 * enumerate them. This survives Railway redeploys, unlike the previous local
 * data/pending-approvals.json — which is kept as a fallback for local dev when
 * Upstash env is absent.
 *
 * Only the storage backend changed: id format, item shape and the
 * create/get/update (pending → approved) semantics are unchanged.
 */

const QUEUE_PATH = path.join(process.cwd(), "data", "pending-approvals.json");
const approvalKey = (id: string): string => `world_approval:${id}`;
const APPROVAL_INDEX = "world_approvals_index";
// Abandoned pendings self-clean; generous so out-of-band human approvals survive.
const APPROVAL_TTL_SECONDS = 7 * 24 * 60 * 60;

function loadFile(): ApprovalQueue {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8")) as ApprovalQueue;
  } catch {
    return { items: [] };
  }
}

function saveFile(queue: ApprovalQueue): void {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), "utf-8");
}

function newItem(): ApprovalQueueItem {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = crypto.randomBytes(4).toString("hex");
  return { id: `${date}-${rand}`, createdAt: new Date().toISOString(), status: "pending" };
}

export async function enqueueApproval(): Promise<ApprovalQueueItem> {
  const item = newItem();
  if (upstashConfigured()) {
    await upstashCommand([
      "SET", approvalKey(item.id), JSON.stringify(item), "EX", String(APPROVAL_TTL_SECONDS),
    ]);
    await upstashCommand(["SADD", APPROVAL_INDEX, item.id]);
    return item;
  }
  const queue = loadFile();
  queue.items.push(item);
  saveFile(queue);
  return item;
}

export async function findPendingItem(id: string): Promise<ApprovalQueueItem | undefined> {
  if (upstashConfigured()) {
    const raw = await upstashCommand<string | null>(["GET", approvalKey(id)]);
    if (!raw) return undefined;
    const item = JSON.parse(raw) as ApprovalQueueItem;
    return item.status === "pending" ? item : undefined;
  }
  return loadFile().items.find((i) => i.id === id && i.status === "pending");
}

export async function markApproved(id: string): Promise<void> {
  if (upstashConfigured()) {
    const raw = await upstashCommand<string | null>(["GET", approvalKey(id)]);
    if (!raw) return;
    const item = JSON.parse(raw) as ApprovalQueueItem;
    item.status = "approved";
    item.approvedAt = new Date().toISOString();
    await upstashCommand([
      "SET", approvalKey(id), JSON.stringify(item), "EX", String(APPROVAL_TTL_SECONDS),
    ]);
    return;
  }
  const queue = loadFile();
  const item = queue.items.find((i) => i.id === id);
  if (item) {
    item.status = "approved";
    item.approvedAt = new Date().toISOString();
    saveFile(queue);
  }
}

export async function listItems(): Promise<ApprovalQueueItem[]> {
  if (upstashConfigured()) {
    const ids = (await upstashCommand<string[] | null>(["SMEMBERS", APPROVAL_INDEX])) ?? [];
    const items: ApprovalQueueItem[] = [];
    for (const id of ids) {
      const raw = await upstashCommand<string | null>(["GET", approvalKey(id)]);
      if (raw) items.push(JSON.parse(raw) as ApprovalQueueItem);
      else await upstashCommand(["SREM", APPROVAL_INDEX, id]); // prune expired
    }
    return items;
  }
  return loadFile().items;
}
