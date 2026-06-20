export interface ApprovalQueueItem {
  id: string;
  createdAt: string;
  status: "pending" | "approved" | "expired";
  approvedAt?: string;
}

export interface ApprovalQueue {
  items: ApprovalQueueItem[];
}

export interface NullifierEntry {
  nullifier: string;
  action: string;
  usedAt: string;
}

export interface NullifierStore {
  entries: NullifierEntry[];
}

export interface WorldIdVerifyResponse {
  results?: Array<{ identifier?: string; success?: boolean; nullifier?: string }>;
  nullifier?: string;
  action?: string;
  created_at?: string;
  message?: string;
}
