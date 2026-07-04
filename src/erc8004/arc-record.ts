/**
 * Arc identity 登録結果の記録。
 *
 * Base の agentId 55560(trade_agent_daily:55560 の記録)とは別物として、専用キー
 * arc_identity:registration と arc_agent_id フィールドに残す。両者を混同しない。
 * 既存の Upstash REST パターンを流用し、ローカル JSON にもフォールバックで残す。
 * 秘密(entity secret / API key / 秘密鍵)は記録しない。
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";

export interface ArcRegistration {
  chain: "ARC-TESTNET";
  arc_agent_id: string; // Arc 上の agentId(Base の 55560 とは別物)
  tx_hash: string;
  identity_registry: string;
  metadata_uri: string;
  explorer_tx_url: string;
  owner_wallet_id?: string; // Circle のウォレット識別子(秘密ではない)。秘密鍵は含めない
  owner_address?: string;
  base_agent_id?: string; // 参照用。Arc とは別物であることを明示するため別フィールドに保持
  registered_at: string;
}

const FILE_PATH = path.join(process.cwd(), "data", "arc", "identity.json");
const KEY = "arc_identity:registration";

export async function saveArcRegistration(reg: ArcRegistration): Promise<void> {
  if (upstashConfigured()) {
    await upstashCommand(["SET", KEY, JSON.stringify(reg)]);
    console.log(`[ARC] registration saved → Upstash (${KEY})`);
  }
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(reg, null, 2), "utf-8");
  console.log(`[ARC] registration saved → ${FILE_PATH}`);
}

export async function loadArcRegistration(): Promise<ArcRegistration | undefined> {
  if (upstashConfigured()) {
    const raw = await upstashCommand<string | null>(["GET", KEY]);
    if (raw) return JSON.parse(raw) as ArcRegistration;
  }
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")) as ArcRegistration;
  } catch {
    return undefined;
  }
}

// ── Reputation / Validation の記録(identity=arc_identity / Base=55560 とは別キー) ──────

export interface ArcReputationRecord {
  chain: "ARC-TESTNET";
  arc_agent_id: string;
  score: number;
  judged_count: number;
  breakdown: { hit: number; partial: number; miss: number };
  tag1?: string;
  tag2?: string;
  feedback_uri?: string;
  feedback_hash?: string;
  tx_hash: string;
  feedback_index: string | null;
  explorer_tx_url: string;
  recorded_at: string;
}

export interface ArcValidationRecord {
  chain: "ARC-TESTNET";
  arc_agent_id: string;
  request_hash: string;
  request_tx_hash: string;
  response_tx_hash: string;
  response: number;
  tag: string;
  explorer_request_url: string;
  explorer_response_url: string;
  recorded_at: string;
}

const REPUTATION_KEY = "arc_reputation";
const VALIDATION_KEY = "arc_validation";
const REPUTATION_FILE = path.join(process.cwd(), "data", "arc", "reputation.json");
const VALIDATION_FILE = path.join(process.cwd(), "data", "arc", "validation.json");

export async function saveArcReputation(rec: ArcReputationRecord): Promise<void> {
  if (upstashConfigured()) {
    await upstashCommand(["RPUSH", `${REPUTATION_KEY}:${rec.arc_agent_id}`, JSON.stringify(rec)]);
    console.log(`[ARC-REP] saved → Upstash (${REPUTATION_KEY}:${rec.arc_agent_id})`);
  }
  fs.mkdirSync(path.dirname(REPUTATION_FILE), { recursive: true });
  fs.appendFileSync(REPUTATION_FILE, JSON.stringify(rec) + "\n", "utf-8");
  console.log(`[ARC-REP] saved → ${REPUTATION_FILE}`);
}

export async function saveArcValidation(rec: ArcValidationRecord): Promise<void> {
  if (upstashConfigured()) {
    await upstashCommand(["RPUSH", `${VALIDATION_KEY}:${rec.arc_agent_id}`, JSON.stringify(rec)]);
    console.log(`[ARC-VAL] saved → Upstash (${VALIDATION_KEY}:${rec.arc_agent_id})`);
  }
  fs.mkdirSync(path.dirname(VALIDATION_FILE), { recursive: true });
  fs.appendFileSync(VALIDATION_FILE, JSON.stringify(rec) + "\n", "utf-8");
  console.log(`[ARC-VAL] saved → ${VALIDATION_FILE}`);
}
