# x402 Autonomous Agent

An autonomous trading intelligence agent that traverses x402 Inc.'s API stack daily,
detecting smart money signals and executing trades via x402 micropayments.
Runs daily at 06:00 JST via node-cron on Railway.

自律型トレーディングインテリジェンスエージェント。毎朝6時JSTにx402 Inc.のAPIスタックを横断し、スマートマネーシグナルを検出してx402マイクロペイメントでトレードを実行します。

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![Railway](https://img.shields.io/badge/Railway-deployed-blueviolet) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## How It Works / 動作フロー

6ステップのパイプラインが毎朝自動実行されます。シグナルがなければ早期終了（低コスト）。

| Step | API | Cost |
|------|-----|------|
| 1. Smart Money Screener | STRONG BUY シグナルをスキャン | $0.05 |
| 2. Whale Intent Decoder | ウォレット意図を検証（ACCUMULATION / POSITION_BUILDING） | $0.30 |
| 3. Divergence Analyzer | オンチェーン／予測市場の乖離を確認 | $0.15 |
| 4. Alpha Memo Protocol | 毎日のAPACレポートを取得 | $1.00 |
| 5. Japan Market Bot | マクロ環境チェック | auto |
| 6. Copy Terminal | 全条件を満たした場合のみ執行 | $0.10 |

> All payments are handled automatically via the x402 protocol. If no signals are found, the agent exits after Step 1 (~$0.05 total).

---

## x402 Payment Flow

```
Agent → GET /api/signals
      ← 402 Payment Required  (PAYMENT-REQUIRED header)
Agent → spending-control policy check (per-tx / daily / allowlist)
      → signs EIP-3009 USDC authorization via Circle Wallets signTypedData
      → GET /api/signals  (PAYMENT header attached)
      ← 200 OK + data
```

`@x402/fetch` handles the 402 handshake automatically; the signature is produced
by **Circle Developer-Controlled Wallets** so the private key never leaves
Circle's HSM.

---

## Circle Developer-Controlled Wallets

The agent signs x402 payments with Circle Developer-Controlled Wallets instead
of a local `PAYMENT_PRIVATE_KEY`. x402's "exact" scheme pays via an off-chain
EIP-3009 `TransferWithAuthorization`, so we only need Circle's `signTypedData`
API — no on-chain transaction, no gas, no exported key.

### One-time setup

```bash
npm install

# 1. Generate an entity secret (32-byte hex) and put it in .env as CIRCLE_ENTITY_SECRET
npx ts-node -e "require('@circle-fin/developer-controlled-wallets').generateEntitySecret()"

# 2. Set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in .env, then register the secret once
npm run circle:register      # writes a recovery file under data/ — store it safely

# 3. Create a wallet set + EOA wallets on testnet (Base Sepolia + Solana Devnet)
npm run circle:setup         # paste the printed CIRCLE_*_WALLET_ID / _ADDRESS into .env

# 4. Fund the EVM address with Base Sepolia USDC: https://faucet.circle.com

# 5. Verify (offline spending-control checks + optional live testnet payment)
TEST_URL=<base-sepolia-x402-endpoint> npm run circle:verify
```

`SIGNER_BACKEND` selects the signer, as an **explicit, production-safe opt-in**:
unset or `privatekey` (the default) keeps the legacy `PAYMENT_PRIVATE_KEY` path,
so existing deployments are unchanged until you set `SIGNER_BACKEND=circle`.
Adding Circle env vars alone does **not** switch the signer.

### Production cutover (Railway)

Merging the integration does **not** change production behavior — the AA keeps
signing with `PAYMENT_PRIVATE_KEY` until you deliberately flip the flag. When
ready to cut over to Circle:

1. **Fund the wallet** — send USDC to `CIRCLE_EVM_WALLET_ADDRESS` on the target
   network (testnet: Base Sepolia via https://faucet.circle.com).
2. **Set the allowlist** — `CIRCLE_ALLOWLIST` = the `payTo` addresses of the
   endpoints the agent pays (and confirm `CIRCLE_PER_TX_LIMIT_USD` /
   `CIRCLE_DAILY_LIMIT_USD`).
3. **Flip the flag** — set `SIGNER_BACKEND=circle` in the Railway Variables tab
   (with `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_EVM_WALLET_ID`,
   `CIRCLE_EVM_WALLET_ADDRESS`). The next daily run signs via Circle.

Rollback is instant: set `SIGNER_BACKEND=privatekey` (or unset it) to return to
the legacy key.

Both `eip155:8453` (Base mainnet) and `eip155:84532` (Base Sepolia testnet) are
registered, so the same wallet works on either network — switch by pointing the
endpoints at testnet or mainnet.

### Spending controls

Enforced in `src/circle/spending-controls.ts`, inside the x402 client's payment
policy — **before** any signature is requested. (Circle's native policy engine
governs on-chain `createTransaction` flows; it does not gate `signTypedData`, so
limits for the gasless x402 flow are enforced agent-side.)

| Control | Env var | Default |
|---|---|---|
| Per-transaction limit | `CIRCLE_PER_TX_LIMIT_USD` | `$5` |
| Daily limit (rolling, UTC) | `CIRCLE_DAILY_LIMIT_USD` | `$20` |
| Recipient allowlist | `CIRCLE_ALLOWLIST` | (none = allow all) |

A request that breaches any limit is dropped from the accepted payment
requirements, so the agent stops rather than over-spending. Daily totals persist
to `data/circle-spend-state.json`.

### Scope (this integration)

- **AA** (Railway daily run) — signing migrated to Circle.
- **Paid x402 endpoints** covered (shared signer in `src/x402.ts`): Yield
  Intelligence, Hyperliquid Intelligence, APAC Macro Dashboard.
- **Onchain Stock Data** (`osd-coral.vercel.app`) is called by the analyst-note
  job via an internal API key (`X-Internal-Key`), **not** x402 — it does no
  signing, so no change was needed there.
- Solana: `src/circle/solana-signer.ts` provides the Circle building block; the
  AA has no Solana x402 endpoint wired yet, so it is not in the active path.

---

## Tech Stack

- **Node.js 20 + TypeScript**
- **@x402/fetch** — automatic HTTP 402 micropayment handling
- **@circle-fin/developer-controlled-wallets** — HSM-backed payment signing
- **node-cron** — `0 21 * * *` (06:00 JST)
- **Railway** — always-on Node.js process

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CIRCLE_API_KEY` | ✅ (Circle) | Circle Developer Console API key |
| `CIRCLE_ENTITY_SECRET` | ✅ (Circle) | 32-byte hex entity secret (register via `npm run circle:register`) |
| `CIRCLE_EVM_WALLET_ID` | ✅ (Circle) | Circle wallet id used for signing (from `npm run circle:setup`) |
| `CIRCLE_EVM_WALLET_ADDRESS` | ✅ (Circle) | EVM address of the Circle wallet |
| `CIRCLE_PER_TX_LIMIT_USD` | — | Per-transaction spending limit (default `5`) |
| `CIRCLE_DAILY_LIMIT_USD` | — | Daily spending limit (default `20`) |
| `CIRCLE_ALLOWLIST` | — | Comma-separated `payTo` allowlist (empty = allow all) |
| `SIGNER_BACKEND` | — | `circle` (default if Circle vars set) or `privatekey` |
| `PAYMENT_PRIVATE_KEY` | legacy | Fallback EOA private key (used only when `SIGNER_BACKEND=privatekey`) |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |

Copy `.env.example` to `.env` and fill in each value. Never commit secrets.

---

## Deployment (Railway)

1. Fork this repo
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo, select the `main` branch
4. Add environment variables in the **Variables** tab
5. Deploy — `railway.json` handles build and start automatically

The service runs as an always-on process. node-cron fires at 21:00 UTC (06:00 JST) daily. No HTTP port is exposed.

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
