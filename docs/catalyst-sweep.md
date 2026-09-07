# 週次 catalyst sweep（買い手・Solana mainnet）

osd（売り手）が per-call 化した `GET /api/catalyst/{ticker}`（~200社）を、AA 買い手が
週1回ループで叩き、1コール **0.0001 USDC = 100 base units** を Solana で払う。目的は
「毎週 N 社 per-call 決済している」証跡であって、データ判断ではない（`executed` には触れない）。

これは元の runbook の**訂正版で canonical**。元 runbook には実害のある誤りがあった（下記「訂正点」）。

## スコープ

- **Part A（roster → `/api/catalyst/{ticker}` 自動生成、`GET /api/catalyst` 一覧）は osd 側**。
  AA はキーも roster も持たず、外から叩くだけ。この repo には無い。
- **Part B（週次で全 ticker を叩いて Solana で払う）が AA=この repo。** 以下は B。

## 手順

```
1. Solana 決済レールが既に有効なことを確認（日次の osd-jin / alpha 系がこのレールで動いている）
   SOLANA_SIGNER_BACKEND=circle + CIRCLE_SOLANA_WALLET_ID/_ADDRESS、専用 SOLANA_RPC_URL。
   → 新しいウォレットも生鍵も足さない。既存の Circle Solana ウォレット(7PVTo…)を共用。
2. npm run catalyst:run0    # ★無課金。一覧取得＋サンプル402読みだけ。配線確認
3. run0 の CSV/ログで「Solana / 公式USDC mint / ちょうど100 units」で 402 が返るのを確認
4. mainnet 1 ticker の dry-run（下記）で実決済を1本だけ通す
5. CATALYST_SWEEP_ENABLED=true    # 毎週水 09:00 JST に sweep
```

手動 sweep は `npm run catalyst:sweep`。

## 決済（既存レールに載せる）

自前で 402 を解析して `@solana/web3.js` で USDC transfer を組んではいけない。x402 の
**exact SVM スキームは facilitator が検証する特定 tx 構造**を要求するので、素の SPL transfer
では通らない（これは元 runbook の手順5〜7の誤り）。既存の `ExactSvmScheme` +
`wrapFetchWithPayment`（`src/catalyst/client.ts`）に通すだけで 402→署名→200 が成立し、
tx ハッシュは `PAYMENT-RESPONSE` ヘッダから既存コードが拾う。

鍵はコードにも env にも置かない。Solana 署名は Circle DCW に移行済みで、AA は wallet id
だけを持つ。sweep は日次 run と**同じ Circle Solana ウォレット**で払う（新ウォレット不要）。

## 安全弁（署名前に効く）

`src/catalyst/client.ts` の `registerPolicy` が、要件選択の段階で次の**すべて**を満たす
要件だけを残す。1つでも外れれば選択肢が消え、ライブラリは**署名せずに中断**する：

- `network` が Solana（`solana` または `solana:<genesis>`）
- `asset` が公式 USDC mint（`CATALYST_USDC_MINT`、既定 `EPjF…Dt1v`）
- 金額が**ちょうど** `CATALYST_PRICE_UNITS`（既定 100 units）。上限ではなく `==`
- `scheme` が `exact`

> **訂正点**: 元 runbook 手順4「payTo=自社受取か」は**逆**。買い手が払う相手（payTo）は
> **売り手のアドレス**で自社ではない。これを検証すると正当な支払いを全部弾く。安全弁は
> payTo ではなく上の3点（network / mint / 金額）。

## 上限（作り直さない）

- **1コール上限**は上の `==100 units` ポリシーが実質そのもの。
- **週上限**は `CATALYST_WEEKLY_CAP_USD`（既定 $0.50）。~200社 全課金でも約 $0.02 なので、
  これは暴走ループの歯止め。算術は既存の `checkBudget`（gas 予算）を再利用。
- 週の消費額は **Upstash 永続**（`catalyst_spend:{ISO週}`）。Railway はデプロイでディスクが
  消えるので、メモリカウンタは上限にならない（probe と同じ教訓）。probe とは別 namespace。

中断条件: 週上限到達で sweep 打ち切り。同一の売り手で3回連続エラーなら sweep 全体を中断
（osd 側の障害とみなす）。

## run 0（無課金）

`--catalyst-run0` は支払いクライアントを構築せず、素の `fetch` だけを使う。課金の余地が
コード上に無い。`GET /api/catalyst` で一覧を取り、**先頭サンプル数件だけ**（`CATALYST_RUN0_SAMPLE`、
既定3）の 402 を読んで、金額・mint・チェーンが期待どおりかを確認する（~200件は同型なので全部は読まない）。

## mainnet 1 ticker dry-run

devnet に配線を足すより、mainnet で1本だけ実決済して確かめるのが最小（「testnet で粘らない」）。

```
CATALYST_RUN0_SAMPLE を使わず、手で1 ticker を叩く例:
  node -e "require('./dist/jobs/catalyst-sweep').runCatalystSweep({mode:'sweep', tickers:['AAPL']})"
```

100 units = 0.0001 USDC の実 tx が Solscan で確認できれば配線 OK。

## 記録

`data/catalyst/catalyst-calls.csv` に 1 ticker 1行で追記（append-only）。

```
at, ticker, outcome, quoted_units, actual_usdc, latency_ms, http, offered_networks, tx, summary, reason
```

- `quoted_units` は 402 から、`actual_usdc` は決済レスポンスから。**掲載価格を写さない**。
- 未確定の値は空欄。0 で埋めない。
- 週次サマリ（社数・paid/free/skip/err・実費合計・代表tx）はこの記録から計算してログに出す。

## `GET /api/catalyst` の返り値

形が未確認（この環境は egress 遮断で叩けない）。`["AAPL", …]` でも
`{tickers:[{ticker:"AAPL"}]}` でも読めるように両対応（`parseTickerList`）。文字列でない
要素は落とし、**ticker を捏造しない**。実際の形が違えば run0 の一覧が空になるので、そこで分かる。

## cron スロット

毎週**水** 09:00 JST（`0 0 * * 3` UTC）。日次 run（21:00 UTC）・Mode C / probe（月）と
衝突しない枠にした。~200件を1社ずつ直列で叩くので、専用 `SOLANA_RPC_URL` 必須
（公開エンドポイントはサーバ常時アクセスをレート制限＝JIN の教訓）。

## 受け入れ条件との対応

- roster に1行 → 新 `/api/catalyst/{ticker}` が叩ける … **Part A（osd 側）**
- 週次で全 ticker を 402→署名→200 … `runCatalystSweep({mode:"sweep"})`
- spend cap が効く／期待外要件を拒否 … `registerPolicy` + `CATALYST_WEEKLY_CAP_USD`（テストで固定）
- 決済 tx が Solscan で確認 … `PAYMENT-RESPONSE` の tx を CSV に記録
