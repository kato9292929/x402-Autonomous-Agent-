# mxe — Arcium MXE for the x402 Autonomous Agent

Arcis circuits (`encrypted-ixs/`), the Solana program that queues them
(`programs/`), and their tests (`tests/`). Built and tested in CI
(`.github/workflows/arcium.yml`), not locally: the Arcium CLI needs a running
Docker daemon.

## What is in it

One program, `aa_mxe`, holds every function, so one MXE — one deployment, one
rent — serves all of them.

| # | Function | Circuits | Revealed |
|---|---|---|---|
| 1 | Reservation-price matching | `seal_floor` → `match_ceiling` | `matched`, and the midpoint only when matched |
| 2 | Sealed-quote RFQ | `open_rfq_state` → `place_quote` × n → `award_rfq` | winner and winning price only |
| 3 | Seller scores, evaluator hidden | `open_scoreboard` → `submit_rating` × n → `reveal_scores` | per-seller aggregates only |
| 4 | Joint purchase, participants hidden | `joint_purchase` (one call, every cap) | `reached`; each share encrypted to its own buyer |
| 5 | Endpoint search, query hidden | `search_catalog_{8,16,32,64}` over a public catalog | match bitmask, encrypted to the querier |

Properties to record, not hide:

- **Function 1.** On a match, either side can recover the other's value as
  `2 × price − own` (±1 for rounding). That is the midpoint rule itself, which
  the brief specifies. Secrecy holds for negotiations that fail.
- **Function 2.** Transaction metadata shows who submitted and how many times.
  AA submits every quote as the relayer, so on chain only AA's signer appears;
  the seller's identity stays inside the encrypted `Quote`.
- **Function 3.** With one evaluator the aggregate IS that evaluator's
  rating; the secrecy is not measurable until other buyers submit. Every slot
  is updated on every rating, so which seller was rated is hidden too — but a
  reveal right after a single rating would attribute it.
- **Function 4.** A buyer can infer the *sum* of the other caps from its own
  share (that is the pro-rata rule). And settlement is a separate layer: if
  each buyer pays the seller directly on a public chain, the payments show who
  paid. The MXE hides participation in the decision, not in the settlement.
- **Function 5.** The catalog is public by design. The query never leaves MPC
  and the result is encrypted to the querier; the transaction still shows that
  a search happened, when, and against which catalog size.
- **All.** Calls on one PDA are serialized — each computation reads the state
  the previous callback wrote. The client awaits finalization before the next.

## Fitting the 1232-byte transaction

Solana caps a transaction — the callback included — at 1232 bytes, so state
size is a design constraint, not a detail:

- An encrypted value costs 32 bytes per field element. Function 3's scoreboard
  unpacked is 32 elements (a 1040-byte `MXEEncryptedStruct<32>`) and cannot be
  carried; as one `Pack<[u32; 32]>` it is **6** elements, 208 bytes. That count
  comes from arcis' own packer (`DataSize::pack_arcis`), not an estimate.
- Arcis packs a bare `Pack<[T; N]>`; a `Pack` nested inside a struct breaks the
  `ArcisType` derive. arcium-hq/examples `blackjack` uses it bare as well.
- Function 5's catalog lives in a `Catalog` PDA and is read by the queue
  instruction, so the search transaction carries only the sealed query at any
  N. u32 prices go through the plaintext-number table, indexed by a u8: at most
  256 entries.

## Fitting the per-circuit compute limit

A comp def registers the circuit's weight (`build/<name>.weight`, from
`arcium build`), and the Arcium program refuses one above its maximum
(`InvalidCUAmount`, 6304). The first `joint_purchase` did three u128 secret
divisions and was refused. Secret division is what is heavy: the current one
works in u32/u64, divides once for a 2^24 fixed-point ratio and turns each
share into a multiply plus a shift by a constant. Its weight is
2,093,527,382 — accepted, and just under 2^31, which is the closest the limit
has been pinned down; any growth of this circuit should be measured first.
Weights per circuit are printed by CI's "Sizes and rent" step.

## Where the circuits live

Stored on chain, the circuits would cost ≈ 28 SOL of rent (CI prints the
figure). The devnet build instead sets `AA_MXE_CIRCUIT_BASE_URL`: each comp def
then points at `{base}/{name}.arcis` with the circuit's hash compiled in, and
the nodes check what they fetch against it, so the host cannot substitute a
circuit. The deploy job publishes the files on the `mxe-circuits` branch under
the commit SHA and checks they are served before deploying. Localnet tests
leave it unset and upload on chain as before.

A comp def cannot be re-initialized. Changing a circuit after a devnet deploy
needs a new program id — bump the label in `scripts/derive-program-keypair.js`
(and `programIdFor` in `src/scripts/mxe-setup.ts`, which a test keeps equal).

## The IDL the AA uses

`idl/aa_mxe.json` is assembled from `cargo test --features idl-build` by
`scripts/assemble-idl.py`, so it can be regenerated without Docker. CI compares
it with the IDL `arcium build` writes and prints any difference. The AA
(`src/mxe/chain.ts`) builds every instruction from it, with all accounts
passed explicitly.

## In the AA

`src/jobs/mxe-trades.ts` runs each enabled function (`MXE_F1…F5_ENABLED`) and
appends one record per function to `mxe_trades` (see `src/mxe/record.ts` for
the fields). Internal trades (functions 1, 2, 4) are then paid over x402 on
Solana mainnet, buyer agent to seller agent; functions 1, 2 and 5 run the
public method beside the sealed one. `/api/mxe` serves the records and the
per-function aggregates; `POST /api/mxe/ratings` is function 3's intake, which
accepts ciphertext only (`npm run mxe:rate` seals a rating on the evaluator's
side).

It runs off Railway, in GitHub Actions: `.github/workflows/mxe-daily.yml`,
daily at 07:30 JST and on demand, in the `mxe` Environment (default branch
only, no reviewer, so the schedule is never held). The internal sellers need
no host — the job serves them on 127.0.0.1 for the length of the run. The
devnet deploy runs in a separate `mxe-deploy` Environment, the one with a
reviewer. `npm run mxe:setup` prints the variables and secret names for both.
Only function 3's intake needs a public server, and waits for one.

## Provenance

The starting point is `sealed_bid_auction` from
[arcium-hq/examples](https://github.com/arcium-hq/examples) at `fe15384`
(ISC, per its `package.json`), with every Arcium component moved from 0.13.2 to
**0.15.0** — the release the devnet cluster runs and `setup-arcium` installs.
Per the release notes, 0.13.2 → 0.14.1 → 0.15.0 needs no source changes for
programs using generated typed callbacks. That port passed CI unchanged
(`2 passing`) before any AA logic was added, so the toolchain and the logic were
verified separately. Account layouts and callback handling still follow it.

## Versions

| Component | Version |
|---|---|
| Arcium CLI, `arcis`, `arcium-*` crates, `@arcium-hq/*` | 0.15.0 |
| Anchor | 1.0.2 |
| Solana CLI | 3.1.10 |
| Rust | 1.89.0 (`rust-toolchain.toml`) |

Keep them on one release. Arcium does not test or guarantee mixed versions.

## Local checks

The circuits compile without the Arcium CLI, which catches Arcis language
violations (dynamic sizes, early returns, …) before CI:

```
cd encrypted-ixs && cargo check
```

The program crate does not: `#[arcium_callback]` reads the compiled circuits
from `build/*.arcis`, which only `arcium build` produces.
