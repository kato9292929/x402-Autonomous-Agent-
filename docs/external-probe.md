# 週次 外部 x402 プローブ

外部5先を週1回叩き、**品質と実費を実測する**ための仕組み。叩いた件数は実需ではない（作業指示書 §9）。
自社完結の内部経済ではなく、境界をまたぐ実決済なので、実費と質は意味のある実測になる。

## 対象（5先）

| # | 先 | host | 掲載 per-call | チェーン | 週の上限本数 |
|---|---|---|---|---|---|
| 1 | OneSource | api.onesource.io | ~$0.004 | ETH / Sepolia / RH Chain | 20 |
| 2 | 2s | 2s.io | $0.0025+ | Base / Solana / ETH | 10 |
| 3 | Otto AI | x402.ottoai.services | $0.001+ | Base / Polygon / Solana | 10 |
| 4 | GoCreative | api.gocreativeai.com | 中央 $0.05（未確認） | 未確認 | 5 |
| 5 | BlockRun | blockrun.ai | 原価+5% | Base / Solana | 5 |

Cluster Protocol はデプロイ基盤でデータ API ではないため対象外。

定義は `src/probe/targets.ts`。**指示書が名前を挙げているルートだけ**が入っている。
2s / GoCreative / BlockRun の有料ルートは空のまま — run 0 が `/.well-known/x402` と
`/openapi.json` を読んで実際に何を売っているかを報告し、そこからルートを足す。
推測でパスを書くと 404 が返り、死んだ売り手と区別がつかなくなる。

## 手順

```
1. npm run build && npm run probe:create-wallet   # Circle DCW に probe 専用ウォレットを作る
2. Railway Variables に CIRCLE_PROBE_WALLET_ID / _ADDRESS を設定
3. そのアドレスに Base USDC $20 を入金（残高ガードが自動で監視対象に加える）
4. npm run probe:run0                              # ★課金ゼロ。到達性・402・単価を確認
5. run 0 の CSV を見て、未確定の先の有料ルートを targets.ts に追記
6. PROBE_ENABLED=true                              # 毎週月 09:00 JST に sweep
```

**4 を通すまで 5 以降に進まない**（指示書 §3）。run 0 は支払いクライアントを構築すらせず、
素の `fetch` しか使わない。課金が起きる余地がコード上に無い。

手動 sweep は `npm run probe:sweep`。

## 上限

| 単位 | 上限 | env |
|---|---|---|
| 1コール | $0.20 | `PROBE_PER_CALL_CAP_USD` |
| 1回(sweep) | $2.00 | `PROBE_PER_RUN_CAP_USD` |
| 週 | $4.00 | `PROBE_WEEKLY_CAP_USD` |

週上限が1回上限の2倍なのは、手動リトライで2回目が丸ごと弾かれないようにするため。

強制のかかり方:

- **1コール上限**は `registerPolicy` の中で効く。x402 の要件選択時に走るので、**署名より前**。
  上限を超える要件は選択肢から消え、ライブラリは払わずに失敗する。
- **1回・週の上限**も同じ policy の中で判定する（`allowsCall`）。天井の算術は
  `src/erc8004/gas-budget.ts` の `checkBudget` を再利用しており、ceiling が食い違う場所を作らない。
- 週の消費額は Upstash に持つ。Railway のローカルディスクは再デプロイで消えるので、
  ローカル JSONL だけだとデプロイのたびに週上限がゼロに戻り、上限として機能しない。

中断条件: 予算到達で sweep 全体を打ち切り、同一先で3回連続エラーならその先を当日スキップ。

## 読み取り専用

`/swap` `/trade` `/execute` `/order` `/transfer` `/withdraw` `/bridge` `/deposit` `/mint`
`/sell` `/buy` を含むパスは**どの先でも**呼ばない。Otto AI の執行系だけを名指しで避けるのではなく、
パターンで全先に適用する。テストで「対象リストに一件も無いこと」と「混ざっても呼び出し0であること」
の両方を固定している。

## 記録

`data/probe/probe-calls.csv` に1コール1行で追記（append-only）。

```
at, target, path, method, outcome, quoted_usdc, actual_usdc, latency_ms, http,
offered_networks, chain, tx, summary, reason, quality
```

- `quoted_usdc` は売り手の 402 から、`actual_usdc` は決済レスポンスから取る。
  **掲載価格は写さない** — §9 が言うとおり掲載と実課金は乖離しうるので、乖離が見えなくなる。
- 読めなかった値は空欄。0 で埋めない。
- `quality`（5段階）は人の判断なので**エージェントは書かない**。空欄のまま残す。
- 先ごとの週次サマリ（コール数・実費合計・実測 per-call・成功率）はこの記録から計算して
  ログに出す。同じ数字を二重に保存すると、行と食い違うサマリが生まれる。

## 費用

想定 ~50 コール/回で 1回 $0.41、年 $21 程度。週上限 $4 があるので、想定が外れても年 $200 は超えない。

## 指示書からの逸脱

- **CSV の置き場**: 「既存の推移CSVと同じ置き場」とあるが、このリポジトリに既存の CSV は無い。
  `data/probe/` に新設した（`data/runs/` `data/osd/` と同じ `data/` 配下）。
- **cron スロット**: §0 は「Mode C と同じ週次スロット」、§2 は「月 09:00 JST」。
  時刻の指定が具体的な §2 を採り、`0 0 * * 1`（UTC）= 月 09:00 JST にした。
  Mode C の既存スロットは `0 21 * * 1`（UTC）= **火** 06:00 JST で、別枠になる。
- **チェーン**: probe ウォレットは Base のみ。Base USDC $20 から始める指示に合わせている。
  Solana / Robinhood Chain しか受けない先は「対応チェーンなし」として skipped で記録され、
  run 0 の結果を見てから配分を決める（推測で他チェーンに資金を置かない）。
