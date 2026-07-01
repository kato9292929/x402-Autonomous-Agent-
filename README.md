# x402 Autonomous Agent

An autonomous trading intelligence agent that traverses x402 Inc.'s API stack daily,
detecting smart money signals and executing trades via x402 micropayments.
Runs daily at 06:00 JST via node-cron on Railway.

自律型トレーディングインテリジェンスエージェント。毎朝6時JSTにx402 Inc.のAPIスタックを横断し、スマートマネーシグナルを検出してx402マイクロペイメントでトレードを実行します。

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![Railway](https://img.shields.io/badge/Railway-deployed-blueviolet) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## How It Works / 動作フロー

毎朝、Mode B（日次ブリーフィング）→ Mode A（日次判断ループ）の順に自動実行されます。

### Mode A — 日次判断ループ

Mode A は早期終了せず、毎ラン必ず一つの日次 call（買い / 見送り ＋ 方向 ＋ サイズ案）を出します。
判断入力は Mode B が既に取得済みの実データを再利用し（二重課金しない）、方向解釈にのみ Whale Intent Decoder を新規に支払います。

| 役割 | シグナル源 | 取得 |
|------|-----------|------|
| 起点（strength） | Divergence Analyzer（`nansenNetFlowUsd`） | Mode B の結果を再利用 |
| 確度（conviction） | Hyperliquid Intelligence（建玉の偏り） | Mode B の結果を再利用 |
| 方向（direction） | Whale Intent Decoder（intent / confidence） | Mode A が新規に支払い（$0.30） |

3つのシグナルを `score ∈ [-1, 1]` にスコア化し、`|score| ≥ 閾値` なら BUY、未満なら SKIP（見送り）。
方向（long / short）とサイズ案、判断根拠（使った各シグナル値）を、ERC-8004 agentId に紐付けて追記専用ストア（Upstash Redis または ローカル JSONL `data/decisions/mode-a-decisions.jsonl`）に記録します。

> **実発注は結線していません。** smct `/api/execute` は呼ばれず、記録は「エージェントがこう判断した」までに限定されます（`executed: false`）。約定・P&L は含みません。Smart Money Screener は候補ゼロ（Nansen が Solana 未対応）のため判断入力から外しています。

> All payments are handled automatically via the x402 protocol.

---

## x402 Payment Flow

```
Agent → GET /api/signals
      ← 402 Payment Required  (x-payment-required header)
Agent → signs USDC payment with PAYMENT_PRIVATE_KEY (EOA on Base mainnet)
      → GET /api/signals  (X-PAYMENT header attached)
      ← 200 OK + data
```

`x402-fetch` handles this automatically — no manual payment logic needed.

---

## Tech Stack

- **Node.js 20 + TypeScript**
- **x402-fetch** — automatic HTTP 402 micropayment handling
- **node-cron** — `0 21 * * *` (06:00 JST)
- **Railway** — always-on Node.js process

---

## Environment Variables

### Base (EVM) — 必須

| Variable | Description |
|---|---|
| `PAYMENT_PRIVATE_KEY` | EOA wallet 秘密鍵（Base mainnet の USDC を保有すること） |
| `ANTHROPIC_API_KEY` | Claude API key（analyst-daily-note 用） |

### Solana — Solana endpoint を使う場合に必須

| Variable | Description |
|---|---|
| `CIRCLE_API_KEY` | Circle Developer-Controlled Wallets API key |
| `CIRCLE_ENTITY_SECRET` | Circle entity secret（32 バイト hex。Circle dashboard で登録） |
| `CIRCLE_SOLANA_WALLET_ID` | Circle が発行した Solana wallet の ID |
| `SOLANA_WALLET_ADDRESS` | Solana wallet address（Circle console で確認） |
| `SOLANA_MAX_USDC_MICRO` | 1 回の支払い上限 micro-USDC（デフォルト: 1000000 = $1.00） |

### その他（任意）

| Variable | Description |
|---|---|
| `PORTFOLIO_ANALYZE_TARGET` | Portfolio Intelligence 分析対象 wallet address |
| `INTERNAL_API_KEY` | Onchain Stock Data Analyst API key |
| `ANALYST_API_BASE` | Analyst API ベース URL（デフォルト: https://osd-coral.vercel.app） |
| `PORT` | HTTP server ポート（Railway が自動設定。デフォルト: 3000） |

全変数は `.env.example` を参照してください。

---

## Deployment (Railway)

1. Fork this repo
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo, select the `main` branch
4. Add environment variables in the **Variables** tab
5. Deploy — `railway.json` handles build and start automatically

The service runs as an always-on process. node-cron fires at 21:00 UTC (06:00 JST) daily.  
HTTP server listens on `$PORT` (Railway sets this automatically) and exposes `GET /api/latest-external-data`.

---

## Solana 対応セットアップ

AA は Base（EVM）と Solana の両方の x402 endpoint を叩けます。Solana は Circle DCW を通じた manual 402 フローで支払います（`withX402` は Solana 非対応）。

### 1. Circle Solana Wallet の発行

Circle console または API で、既存の wallet set の下に Solana EOA wallet を発行します：

```bash
# Circle DCW API（POST /developer/v1/wallets）
curl -X POST https://api.circle.com/v1/w3s/developer/wallets \
  -H "Authorization: Bearer $CIRCLE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "<uuid>",
    "walletSetId": "<your-wallet-set-id>",
    "accountType": "EOA",
    "blockchains": ["SOL"],
    "count": 1,
    "entitySecretCiphertext": "<encrypted-entity-secret>"
  }'
```

発行された wallet ID と address を Railway の環境変数に設定：
- `CIRCLE_SOLANA_WALLET_ID` = wallet ID
- `SOLANA_WALLET_ADDRESS` = Solana address

### 2. Wallet への入金

Solana wallet に以下を入金してください：
- **USDC on Solana**：支払いに使用（Mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`）
- **SOL（少量）**：初回 ATA 作成時の追加ガス代用（~0.002 SOL）。Gas Station が設定されていてもバッファとして必要

### 3. Gas Station（feePayer）設定

Circle console で Solana mainnet 用の Gas Station policy を作成し、Solana wallet のガス代をスポンサーします。設定後は AA wallet に SOL を持たせなくてもトランザクション送信が可能です（ただし初回 ATA 作成分の SOL は必要）。

### 4. Hyre エンドポイント URL の確認と設定

Hyre/PayAI の実際のエンドポイント URL を確認し、Railway の環境変数に設定します：
- `HYRE_DEFI_INTELLIGENCE_URL` = 確認した URL
- `HYRE_MARKET_SIGNALS_URL` = 確認した URL

URL は [pay.sh カタログ](https://pay.sh) または Hyre 公式ドキュメントで確認してください。設定しない場合はコードの TODO プレースホルダー URL が使用されます（404 になります）。

### 5. 動作確認

```bash
# Solana endpoint への支払いテスト（Railway log で確認）
# [SOLANA] Initial request → https://api.hyre.ai/api/defi/intelligence
# [SOLANA] Challenge parsed — payTo: <addr>, amount: 0.050000 USDC, network: solana
# [CIRCLE] Transfer 0.050000 USDC → <addr> (idempotency: <uuid>)
# [CIRCLE] Transaction confirmed: <signature>
# [SOLANA] Retrying with payment proof — signature: <sig...>
# [SOLANA] Second response: HTTP 200
```

---

## Local Development

```bash
npm install
cp .env.example .env
# Fill in .env values

npm run build       # Compile TypeScript
npm run run-now     # Manual one-shot test run
npm start           # Start cron scheduler
```

---

## APIs Used

| API | URL |
|-----|-----|
| Smart Money Copy Terminal | https://x402smct.vercel.app |
| Whale Intent Decoder | https://x402wid.vercel.app |
| Divergence Analyzer | https://x402nansenpolymarket.vercel.app |
| Alpha Memo Protocol | https://x402amp.vercel.app |
| Onchain Stock Data Analyst | https://osd-coral.vercel.app/api/analyst |

---

## Analyst Job（日本 AI-DC 5銘柄の dated catalyst 生成）

analyst ジョブは米国株のプロース解説から、日本の AI データセンター・サプライチェーン5銘柄の dated catalyst 生成に向け直しました（毎日 06:00 JST、`--run-analyst` で手動実行）。出力は AA（agentId 55560）が署名する market="JP" の dated catalyst で、verdict まで追跡します。

対象5銘柄（`config/jp-catalysts.json` で管理。実在の証券コード）:
- イビデン(4062) 半導体パッケージ基板/ABF実装、味の素(2802) ABF絶縁材料、日東紡(3110) ガラスクロス、レーザーテック(6920) EUVマスク検査、ディスコ(6146) ダイシング/グラインディング

各 catalyst は `description`（数値・二値で機械判定可能）・`target_date`（予想日含む）・`thesis`・`conviction`（AAの初期prior 0..1）・`evidence`・`market="JP"`・`agent_id=55560` を持ち、ストア（Upstash / ローカル JSON）に `pending` で保存されます。

データ源の限定（重要）:
- JP では on-chain 系（stocks/liquidity/holders/registry/ipo）を叩きません（トークン化米国株しか持たないため）。
- evidence は `POST /api/wrappers/perplexity-research`（$0.05、銘柄1回/run、`OSD_JP_EVIDENCE_CAP_USD` で上限）からのみ取得します。

submit のゲート（前提確認）:
- osd 側の JP 対応 judge（前提1）と submit の market 受け入れ（前提3）が確認できるまで submit しません。`OSD_JP_SUBMIT_ENABLED=true` を立てたときだけ `POST /api/alpha/catalyst/submit` に market="JP" 付きで送り、`catalyst_id` を保存します。未設定時はローカル記録＋ submit は TODO。
- target_date / estimated_eval_date 経過後の run で score をポーリングし、verdict（hit/partial/miss/na）を確定保存します。

注: 旧 US analyst（`/api/analyst` + `config/analyst-tickers.json` + note 生成）の削除は別判断（`config/analyst-tickers.json` は osd consumption の US データ叩きで引き続き使用）。

---

## osd Consumption Job

毎日の daily run 末尾で、osd（`https://osd-coral.vercel.app`）の稼働中 x402 エンドポイントを実消費します（`runOsdConsumption`）。手動実行は `node dist/index.js --run-osd`。

**Step 1（最優先）— Phase A 往復**
- `config/catalysts.json` の未送信 seed を1件 `POST /api/alpha/catalyst/submit`（無料）。`catalyst_id` を永続ストア（Upstash、無ければローカル JSON）に保存し `pending` に。
- `estimated_eval_date` を過ぎた pending catalyst を `GET /api/alpha/catalyst/{id}/score` でポーリングし、verdict（hit/partial/miss/na）確定でストア更新＋ログ。

> **Phase A を動かすには `config/catalysts.json` に実在の catalyst を入れてください**（初期は空）。各 seed は機械判定可能であること＝`description` に数値/二値条件、`target_date` に**実在の予定日**（YYYY-MM-DD）。数値・期日の無い曖昧な seed は submit されません。
> ```json
> { "catalysts": [
>   { "key": "nvda-fq3-2026", "ticker": "NVDA",
>     "description": "FQ3 決算で AI 売上が前年比 +50% 超",
>     "target_date": "2026-11-19" }
> ] }
> ```

**Step 2 — 有料データ消費（x402）**
- 毎日：`GET /api/stocks/{ticker}`（$0.01）＋ Solana の `GET /api/liquidity`・`GET /api/holders`（各 $0.01）。1 run の有料データ上限はデフォルト $0.20（`OSD_DATA_SPEND_CAP_USD`）。
- 週1（デフォルト月曜 UTC）：`POST /api/predict` を `depth=quick`（$0.50）で1回。standard/deep は日次では呼びません。

**Step 3 — ログ**
- 各コールを `{ endpoint, price_usd, network, tx_or_settlement_ref, ts }` で消費ログに追記（Upstash list `osd_consumption_log` ＋ ローカル `data/osd/consumption-log.jsonl`）。

調整用 env は `.env.example` の「osd consumption ジョブ」を参照。

---

## Cost Per Run

| Condition | Estimated Cost |
|---|---|
| No signals found (early exit) | ~$0.05 |
| Signals found, intent check only | ~$0.50 |
| Full run with execution | ~$1.60–$2.10 |

---

## Arc Testnet ERC-8004 identity 登録（独立スクリプト）

AA のオンチェーン身元（ERC-8004）を Arc Testnet にも登録します。Base の agentId 55560 とは別物として、Arc 上の agentId を取得・記録します。AA 本体（Mode A/B/C、Base/Solana 決済、cron）には接続していない独立処理です。

前提: use-arc Skill / Arc docs を一次情報として確認してから実行します（chain・コントラクト・関数を憶測で確定しない）。実行には Circle 認証（`CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET`）と Arc/Circle への到達が必要で、egress 制限のある環境では動きません。

一次情報の値（指示書の Arc docs 由来。`src/erc8004/arc-contract.ts`）:
- RPC: https://rpc.testnet.arc.network/ 、Explorer: https://testnet.arcscan.app 、Faucet: https://faucet.circle.com
- Circle blockchain 識別子: ARC-TESTNET 、gas は USDC（約 0.006 USDC-TESTNET/tx、Gas Station でスポンサー可）
- IdentityRegistry: 0x8004A818BFB912233c491871b3d84c89A494BD9e（register(string metadataURI) を呼ぶと identity NFT が mint される。agentId = Transfer イベントの tokenId）

手順（dist で実行）:
```
# 1. owner / validator ウォレットを ARC-TESTNET(SCA) で作成
node dist/scripts/arc-create-wallets.js
# 出力の CIRCLE_ARC_OWNER_WALLET_ID / ARC_OWNER_ADDRESS 等を env に設定

# 2. 両アドレスに faucet(https://faucet.circle.com) で testnet USDC を入れてガスを用意

# 3. register を実行して Arc agentId を取得・記録
node dist/scripts/arc-register-agent.js
```

記録: `arc_identity:registration`（Upstash）と `data/arc/identity.json` に `arc_agent_id` / `tx_hash` / `owner` を残します（Base の 55560 とは別フィールド）。秘密（entity secret / API key / 秘密鍵）は記録・ログに出しません。

完了の判定: register の tx と agentId を https://testnet.arcscan.app で目視確認するまで「登録完了」としません（自動判定はしません）。

要確認（実行前に use-arc Skill / docs で確定）:
- Circle DCW の contractExecution で ARC-TESTNET を対象にする指定方法（owner ウォレットが ARC-TESTNET なら walletId 由来で Arc に送られる想定。blockchain 明示が要るか確認）
- register の正確な ABI シグネチャ（`register(string)` を採用）
- metadataURI の期待形式（HTTP URL か ipfs://。既定は AA の agent-card URL）

次段（対象外）: ReputationRegistry / ValidationRegistry による reputation・validation 記録。

---

## License

MIT
