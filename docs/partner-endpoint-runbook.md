# 外部エンドポイントを叩くまでの手順

パートナーから「うちのエンドポイントを叩いてほしい」と言われたときの手順。
相手が誰であれ同じ道を通す。**例外を作らない**こと自体が安全装置になっている。

既存の仕組み（`src/probe/`）がそのまま使える。新しい配線は要らない。

---

## 前提：自社と第三者は別物

| | 対象 | 決済 |
|---|---|---|
| 日次 Mode B / D | 自社エンドポイント（`x402jp.com`・`x402*.vercel.app` ほか） | 常時稼働 |
| **外部 probe** | **第三者**（OneSource / 2s / Otto AI / GoCreative / BlockRun） | `PROBE_ENABLED` 既定 off |

「外部を叩いた」と言えるのは probe を**有料で**回したときだけ。run 0 は 402 を
確認するだけで 1 円も払っておらず、実決済の証跡にはならない。

---

## 手順

### 1. 相手のルートを分類する

叩いてよいのは **読み取り専用**だけ。`src/probe/targets.ts` の
`EXECUTION_PATH_PATTERNS` に載るパスは、run 0 でも sweep でも自動で除外される。

```
/swap /trade /execute /order /transfer
/withdraw /bridge /deposit /mint /sell /buy
```

パスにこれらの語が含まれると `isExecutionPath()` が真になり、コード側で弾かれる。
**リストは緩めない。** 相手が「この /execute は安全だ」と言っても、判断を人間の
確認に委ねる形にはしない。読み取り専用の別ルートを出してもらう。

判断に迷うもの（`/generate`・`/render` など課金が重いが読み取り専用）は、
`weeklyCallBudget` を小さく（3〜5）して様子を見る。

### 2. `src/probe/targets.ts` に追加する

```ts
{
  id: "partner-x",                      // 小文字・記録の namespace になる
  name: "Partner X",
  host: "https://api.partner-x.com",    // 末尾スラッシュなし
  listedPerCallUsd: 0.002,              // 公開価格。読めないなら省く(推測しない)
  listedChains: ["base", "solana"],     // 参考値。実際の対応は 402 が決める
  weeklyCallBudget: 10,                 // 1 sweep で払う最大コール数
  metadata: ["/.well-known/x402", "/openapi.json"],  // 無課金で読む自己申告
  probes: [{ path: "/api/quote?symbol=NVDA", method: "GET" }],
  question: "何を測りたいのか",          // 空欄にしない。後で判断がつかなくなる
}
```

`listedPerCallUsd` は**分からなければ書かない**。埋めるために推測した数字は、
後で実測と突き合わせたときに嘘になる。実際の請求額は決済レスポンスから取る。

`question` は必須のつもりで書く。「なぜこの先を叩いているのか」が残らないと、
半年後に消してよいか判断できない。

### 3. run 0（無課金）で確認する

```
npm run build && npm run probe:run0
```

`mode === "discovery"` の経路は**支払いクライアントを構築すらしない**ので、
課金の余地がコード上に無い。見るべきは3点。

- **402 が返るか** — 返らないならそもそも x402 エンドポイントではない
- **提示額** — `listedPerCallUsd` と桁が合っているか。合わなければ相手に確認
- **対応チェーン** — `eip155:8453`（Base）か `solana:…` か。どちらも無ければ払えない

ここで 402 が返らない・チェーンが合わない先は、**追加せずに差し戻す**。

### 4. 上限を確認する

`src/probe/budget.ts`。既定値で足りるかを、追加した先の提示額と照らす。

| 単位 | 既定 | env |
|---|---|---|
| 1 コール | $0.20 | `PROBE_PER_CALL_CAP_USD` |
| 1 実行 | $2.00 | `PROBE_PER_RUN_CAP_USD` |
| 1 週 | $4.00 | `PROBE_WEEKLY_CAP_USD` |

上限は `registerPolicy` で**要件選択の段階**に効く。予算を超えるコールは
選べる要件が消えるので、署名も送信もされない。払ってから止めるのではない。

高価な先（1 コール $0.05 超）を足すときは `weeklyCallBudget` を先に絞る。
上限に当たって sweep が途中で切れると、他の先の計測も取れなくなる。

### 5. 有料で 1 回叩く

```
npm run build && npm run probe:sweep
```

`--probe-sweep` は `PROBE_ENABLED` に依存しない。**定期実行を有効にせずに
手動で 1 回だけ**払えるので、まずこれで確かめる。

### 6. 結果を確認する

- `[PROBE] <target>: N calls (paid P, skip S, err E) 実費 $X / 実測per-call $Y / 成功率 Z%`
- CSV `data/probe/probe-calls.csv` に 1 コール 1 行で残る
- 週次支出は Upstash に namespace `probe` で積算される

**実測 per-call が掲載価格と乖離していたら相手に確認する。** 推測で埋めない。

### 7. 定期実行にするか決める

継続的に叩くなら `PROBE_ENABLED=true`（毎週月 09:00 JST）。
単発の検証で終わるなら**有効にしない**。手動 sweep だけで足りる。

---

## 失敗したときの読み方

`HTTP 402: {}` は 2 つの違う意味を持つ。`src/caller.ts` の診断がこれを分ける。

| 出力 | 意味 | 次に見るところ |
|---|---|---|
| `再チャレンジ(支払い未受理) vN offered=…` | 売り手が支払いを受理していない | 提示チェーンがこちらの対応と合っているか / 相手の facilitator |
| `再チャレンジなし` | 受理された。200 に至らなかったのは後段 | 相手のアプリケーション側 |
| `Failed to create payment payload:` | こちらが組み立てられなかった | 上限・署名・RPC |
| `offered=` にこちらが払えないチェーンしか無い | 相手の対応チェーン違い | 相手に Base か Solana を出してもらう |

成功時は `via=` に**実際に決済したチェーン**が出る。設定ラベルと食い違えば警告が出る。
ラベルを信じて切り分けを誤った実例があるので、`via=` を見ること。

---

## やらないこと

- **危険ルートの除外リストを緩めない。** 相手の説明で例外を作らない
- **提示価格を推測で埋めない。** 読めないなら空にする
- **上限を上げてから叩かない。** 上限に当たったらまず `weeklyCallBudget` を下げる
- **run 0 を飛ばさない。** 402 もチェーンも確認せずに払わない
- **相手の自己申告（`/.well-known/x402`・`openapi.json`）を実測の代わりにしない。**
  実際の請求額は決済レスポンスから取る

---

## チェックリスト

```
[ ] 読み取り専用ルートだけを選んだ（執行系は相手に別ルートを依頼した）
[ ] targets.ts に追加した（listedPerCallUsd は分かる場合だけ／question を書いた）
[ ] run0 で 402・提示額・対応チェーンを確認した
[ ] 提示額に対して weeklyCallBudget と上限が妥当か確認した
[ ] 手動 sweep を 1 回回した
[ ] 実測 per-call と掲載価格の乖離を確認した
[ ] 継続するなら PROBE_ENABLED、単発なら有効にしない
```
