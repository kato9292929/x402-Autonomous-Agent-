# x402 Autonomous Agent

An autonomous agent with an on-chain identity (ERC-8004) that **pays for data per call in USDC over the x402 protocol**, signing every settlement with **Circle Developer-Controlled Wallets (DCW)** on **Base** and **Solana**. It runs on a daily schedule on Railway, buys machine-readable market data from x402-gated endpoints, and records each decision to an append-only, on-chain-anchored store.

This repository is the **CONSUME** layer of a three-layer stack (details below). Every claim in this README is backed by real on-chain transactions listed in **[On-chain evidence](#on-chain-evidence)** — nothing here is a mock or a testnet-only simulation unless explicitly labelled.

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![Railway](https://img.shields.io/badge/Railway-deployed-blueviolet) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Why this is relevant to Circle

- **Circle DCW is the signer of record.** In production the agent's Base (EVM) x402 payments are signed by a Circle Developer-Controlled Wallet (`0xAE7C34B72D0f49605ee2448C5f0D0eCFB4fcfeC8`) — no raw private key in the hot path. Entity-secret encryption (RSA-OAEP) and Circle's signing APIs are used directly.
- **Circle DCW signing extended to Solana — proven end-to-end.** `@x402/svm` expects a local `@solana/kit` transaction signer; Circle DCW is MPC/custodial and signs *externally-built* transactions via its `signTransaction` API. We built a thin adapter (`src/poc/circle-solana-signer.ts`) that presents Circle DCW as a `@solana/kit` `TransactionPartialSigner`, and settled a real Solana USDC x402 payment with it on mainnet (tx `3ccb95…`, payer = Circle DCW wallet `7PV…`). This is, to our knowledge, a novel integration path and the mechanism to unify agent signing on Circle across EVM, Solana, and Arc.
- **USDC micropayments are the product, not a demo.** The agent pays $0.01–$0.50 per call over x402 and receives HTTP 200 + data. Payments settle on-chain in USDC (Base and Solana SPL), verifiable on Basescan / Solscan.
- **On-chain identity via Circle.** The agent's ERC-8004 identities (Base agentId `55560`, Arc Testnet agentId `845265`) are registered through Circle DCW wallets.
- **Verifiable, immutable track record.** Every decision and every settlement reference is written to an append-only store; on-chain settlements are the ground truth. We do not delete records.

---

## Three-layer stack

| Layer | Role | This repo |
|---|---|---|
| **MAP** | A daily-updated directory of x402-gated endpoints, aggregated and normalized from multiple sources, served over REST + MCP so agents can discover payable APIs. | — |
| **CONSUME** | This agent: an ERC-8004 identity that pays per call in USDC (Circle DCW) and records daily decisions. | **✓ this repo** |
| **PRODUCE** | Proprietary agent-facing data + dated, scored predictions (US/JP equity catalysts; a daily store-price inflation nowcast), served as x402 endpoints. | — |

**Honest framing:** today the agent consumes the stack's *own* endpoints — a self-contained loop that validates the payment-and-observation round-trip end to end. It is a working payment loop, **not** evidence of external demand, and we say so plainly.

---

## On-chain evidence

All settlements below are real, on mainnet, and independently verifiable. USDC recipient (supply side): `4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf`. Solana USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

| What it proves | Chain | Payer | Tx |
|---|---|---|---|
| **Circle DCW signs a Solana USDC x402 payment** (the novel integration) | Solana | Circle DCW `7PV…L6tY` | `3ccb95HKM3a9e2WsSgy6vhvsTJqqunBjnz58qjeEfoSrD3rCzhE7RcBksQ4Q1hwGwohgpA7V6hW1CcVe3fFzfynx` |
| Autonomous agent per-call payment via production path (`pay-once`) | Solana | agent keypair `6JKV…vEzA` | `2LS9cuXRn6nuay3N2XB3nMrE7HJ2fzTjdi1ndnfW237nxmX3BWd7r3vjsTSoUqDf8UrsTM4JRjQLdfG89AKmhtwU` |
| Agent pays a live PRODUCE endpoint (Japan Inflation Nowcast) → 200 + data | Solana | agent keypair `6JKV…vEzA` | `gkBs7zRZvbwBEVCb5R7p9FadVaZQsytEVkxbrqHUmg7ASSyiB8bH6cEC5dGoNtcaUDCvi3XoNhF446nAavWgL3V` |

> Additional Base (EVM, Circle DCW) and Solana settlements exist in the daily/consumption logs; the three above are the load-bearing proofs for this submission. Open any signature on [Solscan](https://solscan.io) to confirm `SUCCESS / Finalized`, the USDC transfer to the recipient, and that it is a Solana SPL `TransferChecked` (not an EVM transfer).

---

## How it works

The agent runs a daily loop on Railway (`0 21 * * *` UTC = 06:00 JST) and a weekly, human-gated loop.

### Daily: Mode B → Mode A → osd consumption

1. **Mode B — briefing.** Fetches the day's market data from x402 endpoints (paying per call in USDC) and caches it so Mode A does not double-pay.
2. **Mode A — decision.** Never early-exits: every run emits exactly one decision (BUY/SKIP + direction + size proposal). It reuses Mode B's data and pays only for one new signal (Whale Intent, ~$0.30) to resolve direction. The three signals are scored to `score ∈ [-1, 1]`; `|score| ≥ threshold` → BUY, else SKIP. The decision — with the exact signal values used as rationale — is appended to a per-agent store keyed by ERC-8004 agentId (`trade_agent_daily:55560`, Upstash Redis with a local JSONL fallback).
3. **osd consumption.** Exercises live x402 endpoints on Base and Solana (per-call USDC), within a per-run budget cap, and appends each call's settlement reference to a provenance log.

> **Execution is intentionally not wired.** The agent records *what it decided* (`executed: false`); it does not place trades and reports no P&L. This keeps the artifact an honest record of autonomous **payment + decision**, not a trading-performance claim.

### Weekly: Mode C — human-gated action

High-impact actions are queued for **human approval gated by World ID** (proof-of-personhood) before anything executes.

---

## x402 payment flow

```
Agent → GET /endpoint
      ← 402 Payment Required   (PAYMENT-REQUIRED header, v2)
Agent → builds & signs a USDC payment
        · Base:   Circle DCW (SIGNER_BACKEND=circle)  — EIP-3009 / typed-data signing
        · Solana: @x402/svm exact scheme               — SPL TransferChecked, facilitator fee-payer
      → GET /endpoint          (X-PAYMENT / PAYMENT-SIGNATURE header attached)
      ← 200 OK + data          (PAYMENT-RESPONSE header carries the settlement tx)
```

`@x402/fetch` drives the round trip. The client auto-selects the Base or Solana leg from the 402 challenge and pays within a configured per-call USDC cap. The Solana leg uses the [PayAI facilitator](https://facilitator.payai.network) as the transaction fee-payer, so the agent needs no SOL for gas.

---

## Architecture

- **Node.js 20 + TypeScript** (strict), compiled to `dist/`.
- **`@x402/fetch` / `@x402/core` / `@x402/evm` / `@x402/svm`** — x402 v1/v2 client, EVM and Solana (SVM) exact schemes. Versions are pinned so the shipped `dist/` is the single source of truth.
- **Circle Developer-Controlled Wallets** — `@circle-fin/developer-controlled-wallets`; entity-secret RSA-OAEP encryption; EVM typed-data signing in production, Solana `signTransaction` via the adapter (proven).
- **ERC-8004** — on-chain agent identity on Base (`register()`) and Arc Testnet (`register(string)`).
- **Upstash Redis (REST)** with local JSONL fallback — append-only decision + consumption stores.
- **node-cron on Railway** — always-on daily/weekly scheduler; an HTTP server exposes status endpoints and the World ID approval flow.

---

## Diagnostics & reproducibility

Standalone scripts (built to `dist/`, never part of the daily loop) let an operator reproduce every claim on a real network:

| Script | Purpose |
|---|---|
| `dist/pay-once.js` | Pay any `TEST_URL` **once** through the *production* x402 client (policy + Circle DCW + Solana), print the 402, the settlement, and the base58 tx. The proof that the production path works, not a stripped-down mock. |
| `dist/poc/run-circle-poc.js` | Build an x402 payment payload using **Circle DCW as the Solana signer** (no real payment). |
| `dist/poc/run-circle-pay.js` | Same, but settle for real → 200 → base58 tx (produced tx `3ccb95…`). |

```bash
TEST_URL=https://<x402-endpoint> node dist/pay-once.js
```

---

## Configuration

Signer backend is selected by `SIGNER_BACKEND` (`circle` in production, `privatekey` for local dev).

| Variable | Purpose |
|---|---|
| `SIGNER_BACKEND` | `circle` → Base payments signed by Circle DCW (production). `privatekey` → local EOA. |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Circle DCW credentials (LIVE). Used for EVM signing and identity registration. |
| `CIRCLE_EVM_WALLET_ID`, `CIRCLE_EVM_WALLET_ADDRESS` | Circle DCW EVM wallet used to sign Base payments. |
| `PAYMENT_PRIVATE_KEY` | EOA private key holding Base USDC (only when `SIGNER_BACKEND=privatekey`). |
| `SOLANA_PRIVATE_KEY` | Solana keypair for the SVM payment leg (optional; absent → Solana endpoints skipped). |
| `CIRCLE_SOLANA_WALLET_ID`, `CIRCLE_SOLANA_WALLET_ADDRESS` | Circle DCW Solana wallet (Circle-DCW Solana signing / PoC). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Append-only store (falls back to local JSONL if unset). |
| `WLD_APP_ID`, `WLD_RP_ID`, `WLD_SIGNING_KEY` | World ID (Mode C human approval). |
| `ANTHROPIC_API_KEY` | Claude API (note generation). |

See `.env.example` for the complete list. Secrets are never logged.

> **LIVE vs TEST separation.** Mainnet uses the LIVE Circle credentials above. Arc Testnet work uses separate `*_TEST` credentials and never touches LIVE — this separation is enforced in code (`src/circle/arc-test-client.ts`).

---

## Deployment (Railway)

1. Connect this repo, select `main`.
2. Set the environment variables above in **Variables**.
3. Deploy — `railway.json` handles build and start. node-cron fires at 21:00 UTC daily; the HTTP server listens on `$PORT`.

```bash
# Local
npm install
cp .env.example .env      # fill in values
npm run build
npm run run-now           # one-shot manual daily run
npm start                 # start the scheduler
```

---

## ERC-8004 identity (Base + Arc Testnet)

- **Base** — agentId `55560`, `IdentityRegistry.register()`.
- **Arc Testnet** — agentId `845265`, `IdentityRegistry.register(string metadataURI)`; registered via Circle DCW wallets on the `ARC-TESTNET` blockchain (gas paid in USDC, sponsorable via Circle Gas Station). Independent scripts under `src/scripts/` and `src/erc8004/` handle registration, reputation, and validation; they are decoupled from the daily payment loop. See `src/erc8004/arc-contract.ts` for the pinned contract addresses and ABIs.

---

## Scope & honesty notes

- The agent **pays and decides**; it does **not** execute trades (`executed: false`) and makes no performance claims.
- Current daily **Solana** settlements are signed by a native keypair; **Circle DCW Solana signing is proven end-to-end** (tx `3ccb95…`) and is the roadmap to unify signing on Circle across all chains.
- The consumption loop is **self-contained** (the agent buys from the stack's own endpoints) — a validated payment round-trip, not external demand.
- Nothing is called "done" until the base58 tx is confirmed on-chain; this discipline is reflected throughout the codebase and its diagnostics.

---

## License

MIT
