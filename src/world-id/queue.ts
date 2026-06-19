import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ApprovalQueue, ApprovalQueueItem } from "./types";

const QUEUE_PATH = path.join(process.cwd(), "data", "pending-approvals.json");

function load(): ApprovalQueue {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8")) as ApprovalQueue;
  } catch {
    return { items: [] };
  }
}

function save(queue: ApprovalQueue): void {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), "utf-8");
}

export function enqueueApproval(): ApprovalQueueItem {
  const queue = load();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = crypto.randomBytes(4).toString("hex");
  const item: ApprovalQueueItem = {
    id: `${date}-${rand}`,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  queue.items.push(item);
  save(queue);
  return item;
}

export function findPendingItem(id: string): ApprovalQueueItem | undefined {
  return load().items.find((i) => i.id === id && i.status === "pending");
}

export function markApproved(id: string): void {
  const queue = load();
  const item = queue.items.find((i) => i.id === id);
  if (item) {
    item.status = "approved";
    item.approvedAt = new Date().toISOString();
    save(queue);
  }
}

export function listItems(): ApprovalQueueItem[] {
  return load().items;
}
