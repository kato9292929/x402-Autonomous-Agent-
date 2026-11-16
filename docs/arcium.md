# Arcium in the x402 Autonomous Agent

How the agent uses Arcium, what runs today, and what the numbers say. Figures
are from the agent's own records (`GET https://aa.x402jp.com/api/mxe`) and from
Solana devnet / mainnet, as of 2026-11-16. Live view: the **Arcium MXE** card on
[aa.x402jp.com](https://aa.x402jp.com).

## Why

Agents that pay each other per call over x402 leak more than the payment.
Asking a price reveals what you would pay; a quote reveals a seller's floor;
rating a seller reveals who you bought from; joining a group purchase reveals
that you are in it; searching a catalog reveals what you are looking for.
Arcium lets those steps run as sealed computations: the inputs stay encrypted
across an MPC cluster, and only the outcome the protocol needs is revealed.
The payment itself stays plain x402 in USDC.

The agent runs five such functions every day, each beside the public method it
replaces, so the cost of keeping the inputs sealed is measured, not assumed.

## What runs

One Anchor program, **`aa_mxe`** — `B2nEZuSActZNBkcVPmo1eJeHQgToDmrHuBkZk52kZsUd`
on Solana devnet, MXE on **Arcium devnet cluster 456**, Arcium 0.15.0 — holds
all five functions (circuits in [`mxe/encrypted-ixs/`](../mxe/encrypted-ixs),
program in [`mxe/programs/`](../mxe/programs), design notes in
[`mxe/README.md`](../mxe/README.md)).

| # | Function | Sealed | Revealed | Compared with |
|---|---|---|---|---|
| 1 | Reservation-price matching | each side's limit price | whether they match, and the midpoint only on a match | public alternating offers (10% concessions) |
| 2 | Sealed-quote RFQ | every seller's quote | the winner and the winning price only | public quotes, lowest wins |
| 3 | Seller scores, evaluator hidden | each rating and which seller it rates | per-seller aggregates only | — |
| 4 | Group purchase, participants hidden | each buyer's cap | whether the target is reached; each share encrypted to its own buyer | — |
| 5 | Endpoint search, intent hidden | the query | a match bitmask, encrypted to the querier | a plain filter over the same catalog |

In functions 1, 2 and 4 the deal that the computation decides is then **paid
over x402 on Solana mainnet** in USDC, buyer agent to seller agent, from Circle
Developer-Controlled Wallets. Function 3 has a public intake
(`POST /api/mxe/ratings`) that accepts ciphertext only, so an outside
evaluator can seal a rating on its own machine.

### One run

```
07:30 JST (Railway cron)
  for each function:
    seal inputs client-side (x25519 + Rescue, @arcium-hq/client)
    queue_computation  ──►  Arcium devnet cluster 456 (MPC)
                       ◄──  callback tx: outcome (and sealed outputs)
    read the revealed outcome from the callback event
    functions 1/2/4: pay the deal over x402 on Solana mainnet (USDC)
    run the public method beside it; record both
    claim the computation account's rent back
  append one record per function to the store; /api/mxe serves them
```

## Results

**Daily runs.** Runs since 2026-11-01. Each day has 8 runs: functions 1–4, and
function 5 at four catalog sizes.

| JST day | OK | Failures |
|---|---|---|
| 11-01 – 11-02 | 0 / 21 | bring-up: setup, queueing, callback wiring (fixed in code) |
| 11-03 | 13 / 16 | 3 x402 payments (wallet funding; fixed) |
| 11-04 | 8 / 8 | — |
| 11-05 | 7 / 8 | 1 RPC "block not available" (now retried on earlier slots) |
| 11-06 | 8 / 8 | — |
| 11-07 – 11-15 | 0 / 72 | cluster outage: queued, never executed (see below) |
| 11-16 | 8 / 8 | — |

Outside bring-up and the outage, **31 of 32 runs succeeded**.

**Per function**, over all successful runs. Cost is the devnet SOL each run
spent, converted at the mainnet SOL/USD of the day (devnet SOL has no price;
this is a guide to what the same run would cost on mainnet). The unit-cost
ratio is that cost over the value of the deal it decided.

| # | Successful runs | Mean latency | Mean cost | Unit-cost ratio |
|---|---|---|---|---|
| 1 | 5 | 7.7 s | $0.70 | ×171 |
| 2 | 4 | 45.2 s (≈14.5 s without the first run after the outage, 137.5 s) | $1.33 | ×361 |
| 3 | 6 | 8.7 s | $0.71 | — |
| 4 | 5 | 4.4 s | $0.35 | ×60 |
| 5 | 24 | 3.8 s | $0.49 | — |

**Function 5 by catalog size** (the query is the same; the catalog grows):

| Catalog size | CU | Cost (devnet SOL) | Latency |
|---|---|---|---|
| 8 | 432,675,748 | 0.00397 | 3.6 s |
| 16 | 437,991,476 | 0.00454 | 3.7 s |
| 32 | 448,621,908 | 0.00568 | 3.7 s |
| 64 | 469,882,772 | 0.00796 | 4.1 s |

Each doubling of the catalog adds 1–5% CU and latency stays near 4 s; the SOL
cost grows faster, 14–40% per doubling.

**What this says, plainly.** The sealed versions work end to end, daily, and
reach the same decisions as the public methods (match or not, the winning
seller, the matching endpoints); prices can differ where the methods differ
(function 1's midpoint versus alternating offers). At micro-payment deal sizes
($0.002–$0.008) the computation costs 60–360× the deal, so today this is a
measured cost of privacy, not an economical one for deals this small. The
ratio falls as deal size grows and as the per-computation cost falls.

### Latest run on chain (2026-11-16 07:30 JST)

Every computation below finalized with a callback; payments are on mainnet.

| # | Outcome | Callback tx (devnet) | x402 payment (mainnet) |
|---|---|---|---|
| 1 | matched at $0.002597 (public method: matched at $0.002670 after 13 rounds) | `3CZ5YQx8SDJQq8eSCUUjydF33iHsdPwxTYioVb5AGF2zzHmVj5vJY2rGLQjRvQwEDSvfNdFjJu1hgdixLHLtPqQD` | `4Jhdt5H6uenGGYJHmZAZMwdopHQFJGTgXei4F99c5WVas54PxRNvfWUHv4GAPfgEqVbM2U57avdEeF45Lvgi28Yf` |
| 2 | awarded to `6DLE…nEpHJ` at $0.002736 (same as public lowest quote) | `5xXMcRXaZy2U5UZRCv58nETJWFMHju5VUQ4C4tDLdu2AmJ8mcsUb8w55zYYrFV8WfQCzHBBjCND84WY189z94RjF` | `4o3GBipTBKyquGswE1Mt8UVjLXtBnnRBM18GdCeAGn4p2iwX7Ji2Tt2JNE4D9djoCXY1MbxaDeQviWSJFmjckQMN` |
| 3 | rating sealed and aggregated; scores revealed | `drZc3pd5qfjDuDMSen5t315RYxc35GS9xrnkpDViDrfPh2tGLYdPQnTB4oNBfwPxpEnsua28MtHaymQdpiCX5y1` | — |
| 4 | target reached (2 participants) | `2pJ2qxYhXf8yYGzfTg8izJYLUHSu346izhfr5TrCb52cg3NUDCyXKkCmhbjhqgXr4DhY6AmNgn3WC6y6RV4GpFNf` | `5mb9fR8Wf2ANpzxJmuxNkgqc5utgv6zBxHfphCUQNUCxvZLXBE6qJzkUMvH4C6Be8hF9aL23PaCg3Q8Z7uiwzKaP`, `59HLrqwKGG5o2WbJxzrrTyRdFsuiNGgeYCNreZtEfUqEktuk9obPxscv25DvPpjHxUzHyKS5P9AhY1Gmj9452CFA` |
| 5 | 2 matches at N = 64 (same as the plain filter) | `4FRiXMUKqRUoaNHertajmiK8nugJZNB1ARTYNbmKmGoeDE3qrsCvSQHEjZsGf8UvazE1zkZuMoenaqdK5NHdyZB4` | — |

Open devnet txs on [Solana Explorer](https://explorer.solana.com/?cluster=devnet)
and mainnet payments on [Solscan](https://solscan.io).

## Operating it

- **Failure stages.** Every failed run is classified by where it stopped:
  setup, RPC, queueing, waiting for the callback, the callback tx, reading the
  result, or the x402 payment (`src/mxe/stage.ts`). The dashboard lists
  failures by stage.
- **Breaker.** A function that fails at the same stage three days in a row is
  paused and stops spending devnet SOL until resumed by hand
  (`npm run mxe:resume`). Runs inside an established network outage are not
  counted (`src/mxe/breaker.ts`).
- **Rent.** Each computation account holds ~0.003–0.008 devnet SOL of rent. It
  is claimed back right after a finalized computation; earlier ones are swept
  every run, and computations that never executed are reclaimed once Arcium
  expires them (`src/mxe/rent.ts`). The 2026-11-16 sweep reclaimed 71 accounts
  (0.295 SOL).
- **The 2026-11-06 → 11-15 outage.** Both nodes of cluster 456 signed no
  successful callback for any program for eight and a half days; AA's own
  computations ran again within a minute of the cluster's return. The chain
  evidence and a draft note to Arcium are in
  [`arcium-devnet-outage-2026-11.md`](arcium-devnet-outage-2026-11.md).

## Engineering notes

Detail in [`mxe/README.md`](../mxe/README.md); in short:

- **1232-byte transactions.** State is packed so a callback fits: function 3's
  scoreboard is one `Pack<[u32; 32]>` (6 field elements, 208 bytes) instead of
  32 encrypted fields; function 5's catalog lives in a PDA read by the queue
  instruction, so the search transaction carries only the sealed query.
- **Per-circuit compute limit.** The first `joint_purchase` (three u128 secret
  divisions) was refused (`InvalidCUAmount`). The current one divides once for
  a 2^24 fixed-point ratio; its weight is 2,093,527,382, just under 2^31.
- **Circuits off chain.** Stored on chain the circuits would cost tens of SOL
  of rent; each computation definition instead points at a hosted `.arcis`
  file with its hash compiled in, which the nodes check.
- **Secrecy limits, recorded rather than hidden.** On a match in function 1
  either side can recover the other's limit from the midpoint; with a single
  evaluator, function 3's aggregate is that evaluator's rating; function 4
  hides participation in the decision, not in the public settlement; function 5
  hides the query, not that a search happened.

## Honest scope

- **Devnet.** The computations run on Arcium's devnet cluster; only the
  payments are on mainnet.
- **Internal counterparties.** In functions 1, 2 and 4 both sides are the
  agent's own buyer and seller agents. These runs show the mechanism works end
  to end; they are not evidence of external demand.
- **Versions.** AA runs Arcium 0.15.0. v0.16.0 (2026-10-23) needs no changes
  for existing MXEs, and AA's MXE works on the recovered cluster as it is;
  moving to 0.16 is the documented way to keep components in sync.

## What would move it forward

- **A mainnet cluster,** to measure the real (not devnet-equivalent) cost per
  computation.
- **Outside participants:** an external evaluator on function 3's intake, and
  outside sellers quoting into function 2.
- **Larger deals,** where a 60–360× overhead at micro-payment size becomes a
  small fraction.
- From Arcium: a way to watch devnet maintenance or incidents, and guidance on
  when queued computations expire.
