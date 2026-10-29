/**
 * 実行記録(data/arc/registry-run.jsonl / Upstash)から docs/erc8004-registry-run.md の
 * 「実行記録」表を生成する。表は手書きせず、必ずこのスクリプトで埋める。
 *
 *   node dist/scripts/erc8004-run-report.js          # 標準出力に出すだけ
 *   node dist/scripts/erc8004-run-report.js --write  # docs のマーカー間を置換する
 *
 * 記録が空なら「未実行」と明示する(埋まっているように見せない)。
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { loadRunEntries, loadSpentUsd, type RegistryRunEntry } from "../erc8004/registry-run-log";
import { TOTAL_USD_CAP } from "../erc8004/gas-budget";

const DOC = path.join(process.cwd(), "docs", "erc8004-registry-run.md");
const BEGIN = "<!-- BEGIN:RUN-RECORD -->";
const END = "<!-- END:RUN-RECORD -->";

const HEADER =
  "| 日時 | チェーン | レジストリ | 関数 | 対象 | tx | gas実額 | 結果 |\n" +
  "|---|---|---|---|---|---|---|---|";

function cell(s: string | undefined): string {
  if (!s) return "—";
  return s.replace(/\|/g, "\\|");
}

function row(e: RegistryRunEntry): string {
  const fn = e.fn.split("(")[0];
  const tx = e.tx_hash ? `\`${e.tx_hash.slice(0, 10)}…\`` : "—";
  const gas = e.gas_cost_usd !== undefined ? `$${e.gas_cost_usd.toFixed(6)}` : "—";
  const result = e.result === "success" ? "success" : `**${e.result}**`;
  const err = e.error ? ` — ${cell(e.error.slice(0, 80))}` : "";
  return `| ${cell(e.at)} | ${cell(e.chain)} | ${cell(e.registry)} | ${cell(fn)} | ${cell(
    e.subject
  )} | ${tx} | ${gas} | ${result}${err} |`;
}

export function renderRunRecord(entries: RegistryRunEntry[], spentUsd: number): string {
  if (entries.length === 0) {
    return (
      HEADER +
      "\n| — | — | — | — | — | — | — | **未実行（環境B未消化）** |\n\n" +
      `通算 gas: **$${spentUsd.toFixed(6)}** / 上限 $${TOTAL_USD_CAP.toFixed(2)}`
    );
  }
  const body = entries.map(row).join("\n");
  const ok = entries.filter((e) => e.result === "success").length;
  const ng = entries.length - ok;
  return (
    HEADER +
    "\n" +
    body +
    "\n\n" +
    `通算 gas: **$${spentUsd.toFixed(6)}** / 上限 $${TOTAL_USD_CAP.toFixed(2)}` +
    `（success ${ok} 件 / それ以外 ${ng} 件）`
  );
}

async function main(): Promise<void> {
  const entries = await loadRunEntries();
  const spentUsd = await loadSpentUsd();
  const block = renderRunRecord(entries, spentUsd);

  if (!process.argv.includes("--write")) {
    console.log(block);
    return;
  }

  const doc = fs.readFileSync(DOC, "utf-8");
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  if (b < 0 || e < 0) {
    throw new Error(`${DOC} に ${BEGIN} / ${END} マーカーが見つかりません`);
  }
  const next = doc.slice(0, b + BEGIN.length) + "\n" + block + "\n" + doc.slice(e);
  fs.writeFileSync(DOC, next, "utf-8");
  console.log(`[ERC8004-REPORT] ${DOC} を更新しました(${entries.length} 件)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[ERC8004-REPORT] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
