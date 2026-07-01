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
