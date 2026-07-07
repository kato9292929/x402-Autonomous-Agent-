/**
 * 段階2: AA 自身による JIN 有料 endpoint(/api/jin/series)への x402 決済 end-to-end 実証。
 *
 * これは AA が自分で叩く自己完結の実演であって、外部需要ではない。
 *
 * 単発実行(日次 osd ループには載せない):
 *   node dist/scripts/jin-series-oneshot.js
 *
 * 必要 env(既存 osd と同じ LIVE 構成をそのまま流用。TEST 鍵と混ぜない):
 *   SOLANA_PRIVATE_KEY(残高 USDC ≥ 0.01 + 手数料)、facilitator 設定、Circle 系署名 —
 *   いずれも osd 決済が現に通っている実行環境(Railway)に揃っている前提。
 * 任意 env:
 *   JIN_API_BASE(既定 https://jin-orcin-pi.vercel.app)
 *
 * フロー(§4):
 *   1. 疎通 /api/jin/latest と /.well-known/x402.json
 *   2. discovery の series accept leg を読む
 *   3. discovery payTo と 402 payTo の一致確認(不一致なら停止)
 *   4. /api/jin/series 無支払い → 402 と accept leg
 *   5. 既存 osd と同じ経路で 402 どおりに支払い(amount/asset/network は 402 の値)
 *   6. 再取得 200 と本文
 *   7. tx 署名をログ出力(Solana 上の裏取りは人間が RPC/エクスプローラで実施)
 */
import "dotenv/config";
import { initX402Fetch } from "../x402";
import {
  fetchLatest,
  fetchDiscovery,
  collectLegs,
  pickSeriesLeg,
  legAmount,
  probe402,
  payAndFetch,
  jinBase,
  type JinLeg,
} from "../jin/client";

const SERIES_PATH = "/api/jin/series";

function die(msg: string): never {
  console.error(`\n[JIN] 停止: ${msg}`);
  process.exit(1);
}

function legSummary(leg: JinLeg): string {
  return `amount=${legAmount(leg) ?? "?"} asset=${leg.asset ?? "?"} payTo=${leg.payTo ?? "?"} network=${leg.network ?? "?"} scheme=${leg.scheme ?? "?"}`;
}

async function main(): Promise<void> {
  console.log("=== JIN 段階2: AA 自身による x402 決済 end-to-end 実証(単発) ===");
  console.log(`base: ${jinBase()}  resource: ${SERIES_PATH}`);

  // ── §0 疎通(送金より前に必ず通す) ──────────────────────────────────────────
  const latest = await fetchLatest().catch((e) => die(`/api/jin/latest 到達不可: ${String(e)}`));
  console.log(`\n[1] 疎通 /api/jin/latest → HTTP ${latest.status}`);
  if (!latest.ok) die(`/api/jin/latest が 200 でない(HTTP ${latest.status})。環境の到達問題を疑う。`);

  const disc = await fetchDiscovery().catch((e) => die(`/.well-known/x402.json 到達不可: ${String(e)}`));
  console.log(`[2] 疎通 /.well-known/x402.json → HTTP ${disc.status}`);
  if (disc.status !== 200 || !disc.doc) {
    die(`/.well-known/x402.json が 200/JSON でない(HTTP ${disc.status})。環境の到達問題を疑う。`);
  }

  // ── §4-2 discovery の series accept leg ────────────────────────────────────
  const discLegs = collectLegs(disc.doc);
  const discSeries = pickSeriesLeg(discLegs);
  if (!discSeries?.payTo) {
    die("discovery から series の payTo を取得できない。discovery の形式/設定を疑う(コードより先にそちらを疑う)。");
  }
  console.log(`[3] discovery series leg: ${legSummary(discSeries)}`);

  // ── §4-4 無支払いで 402 を受ける ──────────────────────────────────────────
  const probe = await probe402(SERIES_PATH).catch((e) => die(`${SERIES_PATH} 402 取得で例外: ${String(e)}`));
  console.log(`\n[4] 無支払い ${SERIES_PATH} → HTTP ${probe.status}`);
  if (probe.status !== 402) {
    die(`無支払いで 402 が返らない(HTTP ${probe.status})。discovery/決済設定のずれを疑う。`);
  }
  if (probe.legs.length === 0) {
    die("402 の accept leg を decode できない(PAYMENT-REQUIRED ヘッダ/本文いずれも不可)。");
  }
  const live = pickSeriesLeg(probe.legs) ?? probe.legs[0];
  console.log(`    402 accept leg(ライブの正値): ${legSummary(live)}`);

  // ── §4-3 discovery payTo と 402 payTo の一致確認 ──────────────────────────
  if (!live.payTo) die("402 leg に payTo が無い。");
  if (discSeries.payTo !== live.payTo) {
    die(
      `discovery payTo(${discSeries.payTo}) と 402 payTo(${live.payTo}) が不一致。` +
        "JIN 側の設定ずれの疑い。実装を進めず停止(コードより先にそちらを疑う)。"
    );
  }
  console.log(`[5] payTo 一致確認 OK: ${live.payTo}`);

  // ── §6 送信前に対象を明示ログ(単発。ループしない) ─────────────────────────
  console.log("\n[6] 送金前確認(この 1 件のみ送る):");
  console.log(`    resource : ${jinBase()}${SERIES_PATH}`);
  console.log(`    amount   : ${legAmount(live) ?? "?"} (base units, 402 の値を厳密使用)`);
  console.log(`    asset    : ${live.asset ?? "?"} (ライブ値。直書きしない)`);
  console.log(`    payTo    : ${live.payTo}`);
  console.log(`    network  : ${live.network ?? "?"} / scheme ${live.scheme ?? "?"}`);

  // ── §4-5/6 既存 osd と同じ経路で支払い → 200 と本文 ────────────────────────
  console.log("\n[7] 支払い実行(共有 x402 クライアントが 402 どおりに支払う)...");
  const paid = await payAndFetch(SERIES_PATH).catch((e) => die(`支払い/再取得で例外: ${String(e)}`));
  console.log(`    再取得 → HTTP ${paid.status}`);
  console.log(`    tx signature: ${paid.signature ?? "(取得できず)"}`);
  console.log(`    settle network: ${paid.network}`);

  if (paid.status !== 200) {
    die(`支払い後の再取得が 200 でない(HTTP ${paid.status})。決済成功として報告しない。`);
  }

  const bodyStr =
    typeof paid.body === "string" ? paid.body : JSON.stringify(paid.body);
  console.log(`\n[8] series 本文(先頭 600 文字):\n${bodyStr.slice(0, 600)}`);

  // ── §7 完了サマリ(独立確認は人間が Solana 上で実施) ───────────────────────
  console.log("\n=== 完了サマリ(AA 自身による自己完結 end-to-end 実証。外部需要ではない) ===");
  console.log(`- 無支払い時: 402(payTo=${live.payTo}, amount=${legAmount(live)}, asset=${live.asset}, network=${live.network})`);
  console.log(`- 支払い: signature=${paid.signature ?? "(なし)"} 受取先=${live.payTo} 額=${legAmount(live)} base units`);
  console.log(`- 支払い後: HTTP 200 / series 本文取得 = ${bodyStr.length > 0 ? "可" : "不可"}`);
  console.log("- 独立確認 TODO: 上記 signature を Solana(RPC/エクスプローラ)で開き、受取先=payTo・金額一致を裏取りすること。");
  console.log("- signature が Solana 上で成立確認できるまで「決済成功」と最終確定しない。");
}

async function run(): Promise<void> {
  // 既存 osd と同じ支払いクライアントを初期化(Base=Circle DCW / Solana=svm exact)。
  await initX402Fetch();
  await main();
}

run().catch((err) => {
  console.error("[JIN] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
