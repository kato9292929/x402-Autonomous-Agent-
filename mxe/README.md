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

Properties to record, not hide:

- **Function 1.** On a match, either side can recover the other's value as
  `2 × price − own` (±1 for rounding). That is the midpoint rule itself, which
  the brief specifies. Secrecy holds for negotiations that fail.
- **Function 2.** Transaction metadata shows who submitted and how many times.
  AA submits every quote as the relayer, so on chain only AA's signer appears;
  the seller's identity stays inside the encrypted `Quote`.
- **Both.** Calls on one PDA are serialized — each computation reads the state
  the previous callback wrote. The client awaits finalization before the next.

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
