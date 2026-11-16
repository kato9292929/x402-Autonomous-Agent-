# x402 Autonomous Agent

An autonomous agent with an on-chain identity (ERC-8004) that **pays for data per call in USDC over the x402 protocol**, signing every settlement with **Circle Developer-Controlled Wallets (DCW)** on **Base** and **Solana**. It runs on a schedule on Railway, buys machine-readable data from x402-gated endpoints — its own stack's and, since 2026-11-16, third-party endpoints chosen from independent delivery checks — judges whether each paid answer actually had content, and keeps an append-only record of every call.

Live dashboard: **[aa.x402jp.com](https://aa.x402jp.com)** (English / 日本語).

Every claim in this README is backed by real on-chain transactions; see **[On-chain evidence](#on-chain-evidence)**. Nothing here is a mock or a testnet-only simulation unless explicitly labelled.

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![Railway](https://img.shields.io/badge/Railway-deployed-blueviolet) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Why this is relevant to Circle

- **Circle DCW is the signer of record.** The agent's Base (EVM) x402 payments are signed by a Circle Developer-Controlled Wallet (`0xAE7C34B72D0f49605ee2448C5f0D0eCFB4fcfeC8`) — no raw private key in the hot path. Entity-secret encryption (RSA-OAEP) and Circle's signing APIs are used directly.
- **Circle DCW signing extended to Solana.** `@x402/svm` expects a local `@solana/kit` transaction signer; Circle DCW is MPC/custodial and signs *externally built* transactions via its `signTransaction` API. A thin adapter (`src/circle/solana-signer.ts`, first proven in `src/poc/`) presents Circle DCW as a `@solana/kit` `TransactionPartialSigner`. The agent's Solana payments are signed by the Circle DCW wallet `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY`.
- **USDC micropayments are the product, not a demo.** In its daily runs the agent pays $0.001–$0.30 per call over x402 and receives HTTP 200 + data. Payments settle on-chain in USDC (Base and Solana SPL), verifiable on Basescan / Solscan.
- **On-chain identity via Circle.** The agent's ERC-8004 identities (Base agentId `55560`, Arc Testnet agentId `845265`) are registered through Circle DCW wallets.
- **Verifiable, append-only track record.** Every call, its settlement reference and its content verdict are written to an append-only store; on-chain settlements are the ground truth. Records are never rewritten — later corrections are laid over them when read.

---

## Three-layer stack

| Layer | Role | This repo |
|---|---|---|
| **MAP** | A daily-updated directory of x402-gated endpoints ([x402 Endpoint](https://endpoint.x402jp.com)), plus an independent buyer-side check of whether sellers deliver what they describe ([x402 Seller Probe](https://probe.x402jp.com)). | — |
| **CONSUME** | This agent: an ERC-8004 identity that pays per call in USDC (Circle DCW), judges what came back, and records it. | **✓ this repo** |
| **PRODUCE** | Proprietary agent-facing data + dated, scored predictions (US/JP equity catalysts; a daily store-price inflation nowcast; EDINET disclosure metadata), served as x402 endpoints. | — |

**Honest framing:** most of the agent's daily spend is on the stack's *own* endpoints — a self-contained loop that validates the payment-and-observation round trip end to end. That part is **not** evidence of external demand. Since 2026-11-16 the agent also buys ~40 **third-party** endpoints every morning (see [Daily external purchase](#daily-external-purchase-driven-by-seller-probe)); those are real purchases from other operators, made by our agent.

---

## On-chain evidence

All settlements below are real, on mainnet, and independently verifiable. Solana USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

| What it proves | Chain | Payer | Tx |
|---|---|---|---|
| **Circle DCW signs a Solana USDC x402 payment** (the novel integration) | Solana | Circle DCW `7PV…L6tY` | `3ccb95HKM3a9e2WsSgy6vhvsTJqqunBjnz58qjeEfoSrD3rCzhE7RcBksQ4Q1hwGwohgpA7V6hW1CcVe3fFzfynx` |
| Autonomous agent per-call payment via the production path (`pay-once`) | Solana | agent keypair `6JKV…vEzA` | `2LS9cuXRn6nuay3N2XB3nMrE7HJ2fzTjdi1ndnfW237nxmX3BWd7r3vjsTSoUqDf8UrsTM4JRjQLdfG89AKmhtwU` |
| Agent pays a live PRODUCE endpoint (Japan Inflation Nowcast) → 200 + data | Solana | agent keypair `6JKV…vEzA` | `gkBs7zRZvbwBEVCb5R7p9FadVaZQsytEVkxbrqHUmg7ASSyiB8bH6cEC5dGoNtcaUDCvi3XoNhF446nAavWgL3V` |
| Agent pays a **third-party** endpoint chosen from Seller Probe's verdicts (OneSource, block number, $0.001) | Base | Circle DCW `0xAE7C…feC8` | `0x5181d0556f3713e69baf881f7150f0b3026753b6fcafcaf291365ed1d7a7b6ff` |
| A deal decided by a **sealed Arcium computation** (function 1, reservation-price match; callback on devnet `3CZ5YQx8…`) is paid over x402 | Solana | buyer agent (Circle DCW) | `4Jhdt5H6uenGGYJHmZAZMwdopHQFJGTgXei4F99c5WVas54PxRNvfWUHv4GAPfgEqVbM2U57avdEeF45Lvgi28Yf` |

> Every daily and weekly settlement is listed with its tx on [aa.x402jp.com](https://aa.x402jp.com). Open any signature on [Solscan](https://solscan.io) or hash on [Basescan](https://basescan.org) to confirm success and the USDC transfer to the seller.

---

## How it works

Schedules run on Railway with node-cron (times in JST).

| When | Job | What it does |
|---|---|---|
| Daily 06:00 | **Mode B** — briefing | Buys the day's data from configured x402 endpoints, checks each body for content, and cools down endpoints that keep answering empty. |
| Daily 06:00 | **Mode A** — decision | **Stopped since 2026-11-15** (see below). |
| Daily 06:00 | **Mode D / osd consumption** | Buys the stack's own OSD Alpha endpoints (US/JP portfolios, scorecards, catalysts) on Solana, and submits and follows up dated catalysts on osd. |
| Daily 06:00 | **Daily external purchase** | Buys third-party endpoints that x402 Seller Probe judged "as described", the way Seller Probe bought them. |
| Daily 07:30 | **Arcium MXE** | Five sealed agent-to-agent functions on Arcium (devnet cluster 456); the deals they decide are paid with x402 on Solana mainnet. |
| Mon 06:00 | **Mode C** | Queues high-impact actions for human approval gated by World ID. |
| Mon 09:00 | **External probe** | Pays a fixed set of third-party sellers (OneSource, 2s, Otto AI, Exa) to measure real cost and content. |
| Wed 09:00 | **Catalyst sweep** | One per-call payment per company for the ~200-company catalyst roster. |
| Thu 09:00 | **EDINET sweep** | One per-call payment per company for EDINET disclosure metadata. |

> **Execution is intentionally not wired.** The agent records *what it bought and decided* (`executed: false`); it does not place trades and reports no P&L.

### Mode B and content checks

x402 settles before the body arrives, so a 200 can be paid for and still be empty. Every paid body is checked (`src/content-check.ts`): empty lists, a body that only repeats the request, placeholder values (e.g. a `tx_hash` that cannot exist), and a "daily" feed whose text has not changed since an earlier day. An empty day counts like a fallback day: after 3 such days an endpoint is no longer bought daily, only re-checked every 3 days, and the first body with content resumes it.

On 2026-11-15 five endpoints that had answered empty every day were **stopped outright** (`EndpointConfig.disabled`): Smart Money Screener, Divergence Analyzer, Whale Alert, APAC Daily and APAC Macro Dashboard. Past records are kept; the dashboard lists them as stopped, with the reason.

### Mode A

Mode A's only input was the Smart Money Screener response Mode B had already paid for. With that endpoint stopped, Mode A records no decision rather than a meaningless daily SKIP. The decision logic is kept (and tested) for when an input returns.

### Daily external purchase (driven by Seller Probe)

`src/spbuy/` picks the day's targets afresh before every run from **x402 Seller Probe's per-endpoint verdicts** (`probe.x402jp.com/data/curated.json`, the purchases Seller Probe makes "the way the seller documents"). An endpoint is bought when:

- Seller Probe's latest verdict on it is **"as described"**, at most 14 days old;
- it costs at most **$0.01** a call and settles on Base or Solana mainnet;
- the request Seller Probe used is recorded (method, URL, query, body), so it can be reproduced exactly;
- it is listed on x402 Endpoint, and it is not ours (own hosts and payTo addresses are excluded);
- at most **2 per operator**, taken round-robin across categories.

Each call is sent unpaid first and paid only if that answers 402 with a leg the agent can pay, within $0.01 a call and **$0.30 a day** (`SP_BUY_DAILY_USD`). The body is judged with **Seller Probe's own five content checks** (output schema, not empty, input reflected, freshness, data kind — ported in `src/spbuy/judge.ts`) and recorded in Seller Probe's record shape, so results can be compared with its verdicts. When a seller answers without a settlement header, the payment is found on chain (Base: the EIP-3009 nonce's `AuthorizationUsed`; Solana: our signature among the wallet's recent transactions — `src/spbuy/settle-search.ts`).

First run (2026-11-16): 39 endpoints from 23 operators; 38 paid, 37 delivered as described, $0.170.

### Arcium MXE — sealed agent-to-agent deals

Agents that pay each other per call leak more than the payment: a price ask reveals a limit, a quote reveals a floor, a rating reveals a counterparty, a search reveals intent. The agent runs five such steps as **sealed computations on Arcium** (MXE program `B2nEZuSActZNBkcVPmo1eJeHQgToDmrHuBkZk52kZsUd`, devnet cluster 456), each beside the public method it replaces, and settles the resulting deals **over x402 on Solana mainnet** in USDC:

| # | Function | Revealed |
|---|---|---|
| 1 | Reservation-price matching | match or not; the midpoint only on a match |
| 2 | Sealed-quote RFQ | winner and winning price only |
| 3 | Seller scores, evaluator hidden | per-seller aggregates only (public ciphertext-only intake) |
| 4 | Group purchase, participants hidden | target reached; each share to its own buyer |
| 5 | Endpoint search, intent hidden | match bitmask, encrypted to the querier |

Daily since 2026-11-03 at 07:30 JST. Outside bring-up and the 2026-11-06 → 11-15 cluster outage, 31 of 32 runs succeeded, reaching the same decisions as the public methods; latency 4–9 s per function (an RFQ with two quotes ~14 s). At micro-payment deal sizes the computation costs 60–360× the deal — a measured cost of privacy, reported as such. Failures are classified by stage, a function failing at the same stage three days in a row is paused, and computation rent is reclaimed every run.

**Full write-up with results, on-chain txs and limits: [`docs/arcium.md`](docs/arcium.md).** Circuit and program design: [`mxe/README.md`](mxe/README.md). Outage report: [`docs/arcium-devnet-outage-2026-11.md`](docs/arcium-devnet-outage-2026-11.md).

### EDINET weekly: what one call buys

`/api/edinet/{code}` (osd, the seller) returns one company's **latest EDINET disclosure as metadata**: `filer_name`, `doc_id`, `doc_type_code`, `doc_description`, `submit_datetime` and the accounting period. Headline figures (`sales` / `operating_income` / `net_income`) are **not served**: osd paused that extraction for reliability, and they come back `null` with `financials_available:false`. The weekly sweep pays $0.001 (Solana USDC) per company for the ~197 codes of the catalyst roster.

- `src/edinet/schema.ts` reads the metadata (`parseEdinetMetadata`) and judges an answer (`checkEdinetBody`): it has content when `doc_id`, `filer_name` and `submit_datetime` are all present. Nothing is filled in.
- The sweep records the verdict and the metadata per company, stops paying after `SWEEP_EMPTY_STOP` (default 5) empty answers in a row, and stores the counts in the weekly summary.

---

## x402 payment flow

```
Agent → GET /endpoint
      ← 402 Payment Required   (PAYMENT-REQUIRED header, v2)
Agent → builds & signs a USDC payment
        · Base:   Circle DCW (SIGNER_BACKEND=circle)          — EIP-3009 typed-data signing
        · Solana: Circle DCW (SOLANA_SIGNER_BACKEND=circle)   — SPL TransferChecked, facilitator fee-payer
      → GET /endpoint          (PAYMENT-SIGNATURE / X-PAYMENT header attached)
      ← 200 OK + data          (PAYMENT-RESPONSE header carries the settlement tx)
```

`@x402/fetch` drives the round trip. The client selects the Base or Solana leg from the 402 challenge and pays **within a per-call USDC ceiling enforced in the payment-selection policy** — before anything is signed. Each job has its own ceilings (daily run, weekly probe, sweeps, daily external purchase).

### Pre-purchase check (x402 Seller Probe)

Before paying a third-party seller in Mode B/C and the weekly probe, the agent looks up `https://probe.x402jp.com/scores/{host}` (`src/probe-gate.ts`):

- the latest paid measurement was `not_delivered` (paid, nothing delivered) → not bought;
- `buyable_without_input: false` → not bought **only** when it describes the route being called (the Probe's measured route) and the call carries no input; a call with a query string or a body, or to another route of the host, is not affected;
- the Probe not answering, or no record of the host → bought as before; only the lookup is recorded.

Own sellers are never looked up; `PROBE_EXEMPT_HOSTS` adds more.

---

## Dashboard and API

[aa.x402jp.com](https://aa.x402jp.com) shows four cards — External x402 (daily Seller Probe–driven purchase and the weekly probe), Arcium MXE, EDINET weekly and Latest run — each with every settlement and its tx. English or Japanese follows the browser; `?lang=en` / `?lang=ja` forces one.

| Endpoint | Content |
|---|---|
| `GET /api/runs` | Daily runs (Mode B / A / D) with content verdicts, stopped endpoints |
| `GET /api/spbuy` | Daily external purchases: targets, requests, verdicts, txs |
| `GET /api/probes` | Weekly external probe runs, suspended sellers |
| `GET /api/mxe` | MXE records, failures by stage, paused functions, rent sweep |
| `GET /api/sweeps`, `/api/sweeps/{surface}/{week}/items` | Weekly catalyst / EDINET sweeps |
| `GET /api/samples` | Captured response bodies per endpoint |

---

## Architecture

- **Node.js 20 + TypeScript** (strict), compiled to `dist/`; tests with `node:test` (`npm test`).
- **`@x402/fetch` / `@x402/core` / `@x402/evm` / `@x402/svm`** — x402 v1/v2 client, EVM and Solana (SVM) exact schemes. Versions are pinned.
- **Circle Developer-Controlled Wallets** — `@circle-fin/developer-controlled-wallets`; entity-secret RSA-OAEP encryption; EVM typed-data signing and Solana `signTransaction`.
- **Arcium** — `@arcium-hq/client` 0.15 against the devnet cluster 456; the MXE program lives in `mxe/`.
- **ERC-8004** — on-chain agent identity on Base (`register()`) and Arc Testnet (`register(string)`).
- **Upstash Redis (REST)** with local JSONL fallback — append-only stores for runs, decisions, sweeps and purchases.
- **node-cron on Railway** — always-on scheduler; an HTTP server serves the dashboard, the JSON API and the World ID approval flow.

---

## Diagnostics & reproducibility

| Command | Purpose |
|---|---|
| `TEST_URL=<x402-endpoint> node dist/pay-once.js` | Pay any endpoint **once** through the *production* x402 client and print the 402, the settlement and the tx. |
| `npm run spbuy -- --dry-run` | Select today's Seller Probe–driven targets and send the unpaid requests only (nothing is paid). `npm run spbuy` runs it for real. |
| `npm run mxe:resume -- <1-5\|all>` | Resume MXE functions the breaker paused (no argument: show their state). |
| `npm run probe:run0` / `npm run probe:sweep` | Weekly external probe: unpaid discovery / paid sweep. |
| `dist/poc/run-circle-pay.js` | Settle a real Solana x402 payment signed by Circle DCW (produced tx `3ccb95…`). |

---

## Configuration

Signer backends: `SIGNER_BACKEND` (`circle` in production, `privatekey` for local dev) for Base, `SOLANA_SIGNER_BACKEND` for Solana.

| Variable | Purpose |
|---|---|
| `SIGNER_BACKEND` | `circle` → Base payments signed by Circle DCW (production). `privatekey` → local EOA. |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Circle DCW credentials (LIVE). |
| `CIRCLE_EVM_WALLET_ID`, `CIRCLE_EVM_WALLET_ADDRESS` | Circle DCW EVM wallet that signs Base payments. |
| `SOLANA_SIGNER_BACKEND`, `CIRCLE_SOLANA_WALLET_ID`, `CIRCLE_SOLANA_WALLET_ADDRESS` | Circle DCW Solana wallet that signs Solana payments. |
| `SOLANA_RPC_URL` | Dedicated Solana RPC (the public one rate-limits). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Append-only store (falls back to local JSONL if unset). |
| `SP_BUY_ENABLED`, `SP_BUY_DAILY_USD`, `SP_BUY_PER_OPERATOR`, `SP_BUY_MAX_AGE_DAYS` | Daily external purchase: on/off (default on), daily budget ($0.30), per-operator cap (2), verdict age (14 days). |
| `FALLBACK_COOLDOWN_DAYS`, `FALLBACK_PROBE_INTERVAL_DAYS` | Cooldown for endpoints that answer fallback or empty data (3 / 3). |
| `PROBE_URL`, `PROBE_EXEMPT_HOSTS` | Seller Probe location; hosts never looked up. |
| `WLD_APP_ID`, `WLD_RP_ID`, `WLD_SIGNING_KEY` | World ID (Mode C human approval). |

See `.env.example` for the complete list. Secrets are never logged.

> **LIVE vs TEST separation.** Mainnet uses the LIVE Circle credentials above. Arc Testnet work uses separate `*_TEST` credentials and never touches LIVE — enforced in code (`src/circle/arc-test-client.ts`).

---

## Deployment (Railway)

1. Connect this repo and select `main`.
2. Set the environment variables above in **Variables**.
3. Deploy — `railway.json` handles build and start. The HTTP server listens on `$PORT`.

```bash
# Local
npm install
cp .env.example .env      # fill in values
npm run build
npm test
npm run run-now           # one-shot manual daily run
npm start                 # start the scheduler
```

---

## ERC-8004 identity (Base + Arc Testnet)

- **Base** — agentId `55560`, `IdentityRegistry.register()`.
- **Arc Testnet** — agentId `845265`, `IdentityRegistry.register(string metadataURI)`; registered via Circle DCW wallets on the `ARC-TESTNET` blockchain (gas paid in USDC). Scripts under `src/scripts/` and `src/erc8004/` handle registration, reputation and validation, decoupled from the daily payment loop.

---

## Scope & honesty notes

- The agent **pays and records**; it does **not** execute trades (`executed: false`) and makes no performance claims.
- Most of the daily spend goes to the stack's own endpoints — a validated payment round trip, not external demand. The daily external purchase buys from other operators; the MXE functions' internal counterparties are labelled as such.
- A paid call is not counted as delivered unless its body passes the content checks, and not counted as paid unless the transfer is on chain.
- Nothing is called "done" until the tx is confirmed on chain.

---

## License

MIT
