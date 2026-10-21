# mxe — Arcium MXE for the x402 Autonomous Agent

Arcis circuits (`encrypted-ixs/`), the Solana program that queues them
(`programs/`), and their tests (`tests/`). Built and tested in CI
(`.github/workflows/arcium.yml`), not locally: the Arcium CLI needs a running
Docker daemon.

## Provenance

The starting point is `sealed_bid_auction` from
[arcium-hq/examples](https://github.com/arcium-hq/examples) at `fe15384`
(ISC, per its `package.json`), with every Arcium component moved from 0.13.2 to
**0.15.0** — the release the devnet cluster runs and `setup-arcium` installs.

Per the Arcium release notes, 0.13.2 → 0.14.1 → 0.15.0 needs no source changes
for programs using generated typed callbacks; only the versions and lockfiles
change. That is deliberately the whole of this first step, so that a CI failure
here is a toolchain problem and not a logic one. The AA-specific circuits are
built on top of it.

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
