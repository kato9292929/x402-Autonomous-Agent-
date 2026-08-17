/**
 * ERC-8004 レジストリ書き込みの実行記録(追記専用)と gas 通算額。
 *
 * 記録項目(指示書 M3): 日時 / チェーン / レジストリ / 関数 / 対象エントリの識別子 /
 * txハッシュ / gas実額 / 結果。
 *
 * 規律:
 *  - 追記専用。過去のエントリを書き換えない(更新 API を提供しない)。
 *  - 失敗・想定外レスポンスも result="failed" として同じ形式で残す(握りつぶさない)。
 *  - 秘密(API key / entity secret / 秘密鍵)は記録しない。walletId は秘密ではないので可。
 */
import * as fs from "fs";
import * as path from "path";
import { upstashConfigured, upstashCommand } from "../store/upstash-rest";

export type RegistryName = "ReputationRegistry" | "ValidationRegistry";
export type RunResult = "success" | "failed" | "skipped_budget" | "skipped_no_data";

export interface RegistryRunEntry {
  /** ISO8601。記録時刻。 */
  at: string;
  chain: string;
  registry: RegistryName;
  registry_address: string;
  /** 呼んだ関数のシグネチャ(例 giveFeedback(uint256,...))。 */
  fn: string;
  /** 対象エントリの識別子(agentId / requestHash / feedbackHash など)。 */
  subject: string;
  result: RunResult;
  tx_hash?: string;
  /** gas 実額。receipt から採取できた場合のみ埋まる。 */
  gas_units?: string;
  gas_price_wei?: string;
  gas_cost_usd?: number;
  /** 通算 gas(この記録時点)。 */
  cumulative_usd?: number;
  explorer_url?: string;
  /** 失敗理由・想定外レスポンスをそのまま残す。 */
  error?: string;
  /** ライブ未検証の分岐を通った場合のラベル。 */
  unverified?: string[];
}

const LOG_FILE = path.join(process.cwd(), "data", "arc", "registry-run.jsonl");
const LOG_KEY = "erc8004_registry_run";
const SPEND_FILE = path.join(process.cwd(), "data", "arc", "gas-spend.json");
const SPEND_KEY = "erc8004_gas_spend_usd";

/** 実行記録を追記する(Upstash + ローカル JSONL の両方)。 */
export async function appendRunEntry(entry: RegistryRunEntry): Promise<void> {
  const line = JSON.stringify(entry);
  if (upstashConfigured()) {
    await upstashCommand(["RPUSH", LOG_KEY, line]);
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  console.log(
    `[ERC8004-LOG] ${entry.result} ${entry.registry}.${entry.fn.split("(")[0]} ` +
      `subject=${entry.subject}` +
      (entry.tx_hash ? ` tx=${entry.tx_hash}` : "") +
      (entry.gas_cost_usd !== undefined ? ` gas=$${entry.gas_cost_usd.toFixed(6)}` : "")
  );
}

/** 実行記録を読む(新しい順ではなく追記順)。 */
export async function loadRunEntries(): Promise<RegistryRunEntry[]> {
  if (upstashConfigured()) {
    const rows = await upstashCommand<string[] | null>(["LRANGE", LOG_KEY, "0", "-1"]);
    if (rows && rows.length > 0) {
      return rows.map((r) => JSON.parse(r) as RegistryRunEntry);
    }
  }
  try {
    return fs
      .readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RegistryRunEntry);
  } catch {
    return [];
  }
}

/** 通算 gas 消費(USD)を読む。記録が無ければ 0。 */
export async function loadSpentUsd(): Promise<number> {
  if (upstashConfigured()) {
    const raw = await upstashCommand<string | null>(["GET", SPEND_KEY]);
    if (raw) {
      const v = Number(raw);
      if (Number.isFinite(v)) return v;
    }
  }
  try {
    const j = JSON.parse(fs.readFileSync(SPEND_FILE, "utf-8")) as { spent_usd?: number };
    return Number.isFinite(j.spent_usd) ? (j.spent_usd as number) : 0;
  } catch {
    return 0;
  }
}

/** 通算 gas 消費に加算して新しい合計を返す。 */
export async function addSpentUsd(deltaUsd: number): Promise<number> {
  if (!Number.isFinite(deltaUsd) || deltaUsd < 0) {
    throw new Error(`addSpentUsd: 不正な値 ${deltaUsd}`);
  }
  const next = (await loadSpentUsd()) + deltaUsd;
  if (upstashConfigured()) {
    await upstashCommand(["SET", SPEND_KEY, String(next)]);
  }
  fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
  fs.writeFileSync(
    SPEND_FILE,
    JSON.stringify({ spent_usd: next, updated_at: new Date().toISOString() }, null, 2),
    "utf-8"
  );
  return next;
}
