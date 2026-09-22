# `spend-guard-endpoints.json`

The routes this agent actually pays for, described so the Spend Guard shadow
evaluation can judge them. Generated from this repository; **every description
carries its source, and nothing in it is invented.**

## How to read it

| field | meaning |
|---|---|
| `description_source.kind` | `documented` — a real description exists in this repo. `name_only` — no description exists, so `description` is the verbatim `name` from `src/config.ts`. |
| `consuming_task` | the mode that *uses* the data, which is not always the mode whose array the route sits in |
| `in_ab_comparison` / `ab_group` | whether the route is in the question-wording A/B, and which group |

## What the generation found

**20 routes across 12 providers** — 14 Mode B (daily), 5 Mode C (weekly), and
Whale Intent Decoder, which Mode A buys directly and which is in neither array
(`src/modes/modeA.ts:89`).

**Only 4 of 20 routes have any description beyond their name.** Provider APIs
could not be queried for one: egress to them is blocked from the authoring
environment, and `src/modes/signal-extract.ts:6-7` records that this
repository's own environment cannot reach them either. The other 16 carry
their `name` verbatim, marked `name_only`.

**Mode B and Mode C state no per-route need.** Both iterate their whole
endpoint array and buy every route unconditionally
(`src/modes/modeB.ts:97`, `src/modes/modeC.ts:41`), so nothing in the code says
what any single route is required to supply. `required_data` is left empty for
them rather than invented.

Two purchases are worth a second look, and both are recorded in `note` fields
rather than acted on here:

- **`smart-money-screener`** is bought every day but is excluded from Mode A's
  decision input, because Nansen does not cover Solana and it returns zero
  candidates (`README.md:31`).
- **`osd-jin-latest` and `osd-jin-movers`** are written to
  `data/external/…json` (`src/modes/modeB.ts:23-53`), and **no reader for
  `data/external` was found anywhere in this repository.**

Those are observations from a static read, not conclusions — a consumer may
exist outside this repo. They are exactly the pattern shadow mode is meant to
measure, so they are flagged here and left alone.

## Caveat on the shape

The integration spec (3-5) that names this file was not available when it was
written, so this layout is a proposal. Rename or reshape it to match the spec;
the provenance fields are the part worth keeping.

## Regenerating

The file records `source_commit`. Re-derive it after endpoints change, and
re-check the descriptions: a new route will land as `name_only` until someone
writes a description for it.
