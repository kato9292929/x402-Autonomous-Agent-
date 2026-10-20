# 週次 外部 x402 プローブ

外部5先を週1回叩き、**品質と実費を実測する**ための仕組み。叩いた件数は実需ではない（作業指示書 §9）。
自社完結の内部経済ではなく、境界をまたぐ実決済なので、実費と質は意味のある実測になる。

## 対象（5先）

| # | 先 | 選定した有料ルート | 09-18 の402提示額 | 10-20 の402提示額 | 10-20 の提示チェーン | 週の上限本数 |
|---|---|---|---|---|---|---|
| 1 | OneSource | `GET /api/chain/block-number` | $0.001 | $0.001 | Base | 20 |
| 2 | 2s | `GET /api/finance/sec-filings?ticker=NVDA&limit=5` | $0.009 | $0.009 | Base・**Solana** | 10 |
| 3 | Otto AI | `GET /token-details`・`/yield-alpha`・`/crypto-news` | $0.001・$0.002・$0.001 | 同額 | Base・**Solana** | 10 |
| 4 | GoCreative | `GET /v1/fred/series/GDP` | $0.020 | **502(停止中)** | — | 5 |
| 5 | BlockRun | `POST /api/v1/search` | $0.079751 | **$0.081000** | Base | 5 |

この金額は**無課金リクエストに対する402提示額**。決済済みの実費ではない。
実費は有料 sweep の `PAYMENT-RESPONSE` から別途記録する。価格と対応チェーンは実行時に再確認する。

2026-10-20 に run 0 相当の無課金確認を行い、4点が動いていた。

- **GoCreative はオリジン全体が 502**（`/`・`/.well-known/x402`・有料ルートすべて）。
  ルート単体の問題ではないので `suspended` を立て、**有料 sweep では叩かない**。
  対象リストからは外さない — run 0 は無課金なので読み続け、復帰はそこで気づく。
- **BlockRun が $0.079751 → $0.081000**（+1.6%）。1コール上限 $0.20 の内側なので支払いは通る。
- **2s と Otto AI が Solana leg を追加**。9/18 時点はどちらも Base のみだった。
- OneSource が `batch-settlement` scheme の leg を追加（`exact` が `accepts[0]` なので選択は変わらない）。

Cluster Protocol はデプロイ基盤でデータ API ではないため対象外。

定義は `src/probe/targets.ts`。2026-09-18 に各売り手の公開メタデータ・OpenAPI を確認し、
実ルートへの無課金リクエストが 402 を返した読み取り専用の7ルートを設定した。
OneSource は block-number、2s は NVDA の SEC filings、Otto AI は既存の3ルート、
GoCreative は FRED GDP、BlockRun は web search を呼ぶ。単価は各回の 402 で再確認する。

## 手順

**有料実行の前提:** `SIGNER_BACKEND=circle` と既存の
`CIRCLE_EVM_WALLET_ID` / `CIRCLE_EVM_WALLET_ADDRESS` が必要。
probe 専用ウォレットは無く、追加のウォレット作成やUSDC移動も不要。

`CIRCLE_SOLANA_WALLET_ID` / `CIRCLE_SOLANA_WALLET_ADDRESS` が設定されていれば
**Solana leg も登録する**（日次エージェントが既に使っているウォレットと同じ）。
未設定なら Base だけに戻る — 署名できないチェーンを「払える」と数えると、
`observe` が払えない単価を見積もってしまう。
probe の支出は1コール・1回・週の上限と Upstash の消費記録で制限する。
`--probe-run0` はウォレット設定なしでも無課金実行できる。

```
1. npm run build
2. npm run probe:run0                              # ★課金ゼロ。7ルートの402を再確認
3. npm run probe:sweep                             # 既存の Circle Base ウォレットで直ちに有料実行
4. PROBE_ENABLED=true                              # 毎週月 09:00 JST に sweep
```

run 0 は支払いクライアントを構築すらせず、
素の `fetch` しか使わない。課金が起きる余地がコード上に無い。
402 はその都度変わりうるので、手動 sweep でも支払い直前に価格・対応チェーンを確認する。
`PROBE_ENABLED=true` は月曜 09:00 JST の定期実行だけを有効にする。
手動 `--probe-sweep` はこのフラグに関係なく実行される。

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

## どのチェーンで払うか

既定は `@x402/core` の既定セレクタ（`accepts[0]`）。これまでの実測はすべてこの挙動で取っている。

`PROBE_PREFER_NETWORK` に CAIP-2 を入れると、その leg を**優先して**選ぶ。
同じルートを Base と Solana で測って実費を比べるためのもの。

```
PROBE_PREFER_NETWORK=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
```

優先は**予算 policy の後**に効く（`@x402/core` は policy を適用してからセレクタを呼ぶ）。
上限で落とされた leg をここで拾い直すことはできない。
指定したチェーンが候補に無ければ既定に落ちる。

## 記録

**Upstash（`probe_runs`、新しい順・直近120 run）が正。** `/api/probes` とダッシュボードはここを読む。
Railway のローカルディスクは再デプロイで消えるので、ここに置かないと
「第三者にいくら払って何が返ってきたか」の記録が deploy のたびに消える。
週次予算を Upstash に逃がしたのと同じ理由（`probe/budget.ts`）で、行そのものも移した。

ローカルには `data/probe/probe-runs.jsonl` にも追記する（ローカル開発用の fallback）。
Upstash 未設定で走らせた場合は「この run はローカルにしか無い」と warn を出す。
記録されたように見えたまま消えるのが一番まずい。

`data/probe/probe-calls.csv` も従来どおり1コール1行で追記（append-only）。
人が 1〜5 を書き込む `quality` 列があるため、こちらは**作業ファイル**として残す。

```
at, target, path, method, outcome, quoted_usdc, actual_usdc, latency_ms, http,
offered_networks, chain, tx, summary, reason, quality
```

- `quoted_usdc` は売り手の 402 から、`actual_usdc` は決済レスポンスから取る。
  **掲載価格は写さない** — §9 が言うとおり掲載と実課金は乖離しうるので、乖離が見えなくなる。
- 読めなかった値は空欄。0 で埋めない。
- `quality`（5段階）は人の判断なので**エージェントは書かない**。空欄のまま残す。
- 先ごとの週次サマリ（コール数・実費合計・実測 per-call・成功率）はこの記録から計算する。
  同じ数字を二重に保存すると、行と食い違うサマリが生まれる。

## 表示

`GET /api/probes?limit=N` が run を新しい順で返す（既定12・最大60）。
ダッシュボード（`site/`）の **External probe** セクションがこれを読む。

- 見出しに出すのは**最新の有料 sweep だけ**。run 0 は1円も払っていないので、
  「最新の外部決済」として出すと起きていない支出に見える。
- 行は**提示額と実課金を別の列**で出す。§9 が言うとおり掲載と実課金は乖離しうるので、
  1列にまとめるとこの観測の肝が見えなくなる。どちらも欠けうる（402 が無ければ提示額は無い、
  決済していなければ実課金は無い）。
- `skipped` の行は**消さずに薄く出し、理由を行の下に書く**。叩かなかったことも結果。

## 費用

初期設定は7コール/回。実費は決済結果から記録する。予算上限は上記の値を適用する。

## 指示書からの逸脱

- **CSV の置き場**: 「既存の推移CSVと同じ置き場」とあるが、このリポジトリに既存の CSV は無い。
  `data/probe/` に新設した（`data/runs/` `data/osd/` と同じ `data/` 配下）。
- **cron スロット**: §0 は「Mode C と同じ週次スロット」、§2 は「月 09:00 JST」。
  時刻の指定が具体的な §2 を採り、`0 0 * * 1`（UTC）= 月 09:00 JST にした。
  Mode C の既存スロットは `0 21 * * 1`（UTC）= **火** 06:00 JST で、別枠になる。
- **チェーン**: probe ウォレットは Base のみ。Base USDC $20 から始める指示に合わせている。
  Solana / Robinhood Chain しか受けない先は「対応チェーンなし」として skipped で記録され、
  run 0 の結果を見てから配分を決める（推測で他チェーンに資金を置かない）。
