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

## Analyst Daily Note Job

毎朝 06:00 JST に Onchain Stock Data の Analyst API を叩き、日次ノート記事を自動生成します。

- **実行時刻**: 毎朝 06:00 JST（node-cron）
- **対象銘柄**: `config/analyst-tickers.json` で管理
- **同期必須**: `config/analyst-tickers.json` は Onchain Stock Data リポジトリの `data/stocks.json` と必ず同期させること。同期していない銘柄は `ticker_not_found` エラーとなります。
- **銘柄追加手順**: 新しい銘柄を追加するときは、**先に Onchain Stock Data 側の `data/stocks.json` に追加** してから、本リポジトリの `config/analyst-tickers.json` に追加してください。
- **Onchain Stock Data リポジトリ**: https://github.com/kato9292929/onchain-stock-data

---

## Cost Per Run

| Condition | Estimated Cost |
|---|---|
| No signals found (early exit) | ~$0.05 |
| Signals found, intent check only | ~$0.50 |
| Full run with execution | ~$1.60–$2.10 |

---

## License

MIT
