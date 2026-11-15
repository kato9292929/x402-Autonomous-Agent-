# Arcium devnet: no computations executed, 2026-11-06 → 11-15

Investigated 2026-11-15 from Solana devnet chain data (public RPC). Conclusion:
**a network-wide stop of Arcium devnet cluster 456, not a fault of AA's MXE.**
It recovered on 11-15 at 09:51 UTC.

## What the chain shows

Cluster 456 (`DzaQCyfybroycrNqE5Gk7LhSbWD2qfCics6qptBFbr95`) has two Arx nodes.
Every callback transaction is signed by a node's callback authority:

| node offset | arx node account | callback authority |
|---|---|---|
| 45548129 | `7LJGVaXgCS881riQeweXUGdZPou5qCuZaiGpF8DA1ruk` | `2fYMTn21qr8KA5rraCLaF1rjTB7vf9gxkJFT4FTcb8VV` |
| 743829 | `EYdqkc8vd5xPCCFD2L9rMJYKyRQ4mGNvhrb4qcuFdMrd` | `5QPtFKv3AJ3cqbPpWc3mp9FnNZokEHduX3hqR8xuthA3` |

Transactions signed by the two callback authorities, per day (UTC; failed in brackets):

| day | 2fYMTn21… | 5QPtFKv3… |
|---|---|---|
| 11-04 | 3678 (1740) | 3670 (1926) |
| 11-05 | 4433 (2552) | 4430 (2446) |
| 11-06 | 3425 (1581) — last at 22:21:54 | 3395 (1921) |
| 11-07 – 11-08 | 0 | 0 |
| 11-09 | 12 (12) | 21 (21) |
| 11-10 – 11-14 | 0 | 0 |
| 11-15 | 1963 (1298) — first at 09:51:31 | 1962 (1156) |

- From 11-06 22:21:54 to 11-15 09:51:31 UTC, **no program on cluster 456 got a
  successful callback**. The only node activity was 33 failed
  `CallbackComputation` attempts on 11-09 09:26 to program
  `D7g13sS8saFHBA3AqZq8kAdseVYSNYhmA9NsyzNXuWnn` (custom error 0x1).
- Queue transactions kept arriving (≈ 400 writes a day to the cluster account),
  so programs, AA included, kept queueing into a cluster that did not execute.
- After 11-15 09:51 callbacks succeed again for several programs, e.g.
  `AfPU2NwkgqBrdqVfHx49AjCyTHFaMkwY9utuMoxXEVuv` (AddTogether),
  `EW9NrBnyzTtWrc6CipVff8r1NFqKnGsjiFjwnWQoNkRd` (RevealCardOpen),
  `5cE5Kc42mwvg931PfNfs224RuBr47JRk3VqgTSyEV7MS` (LiquidateV2).
- **AA's MXE** (`B2nEZuSActZNBkcVPmo1eJeHQgToDmrHuBkZk52kZsUd`) got successful
  callbacks at 11-15 09:52 for the computations its 11-15 07:30 JST run had
  queued: SealFloor, OpenRfqState, SubmitRating, SearchCatalog8, JointPurchase
  (e.g. `EDKRuzEKjhmNCGgThu5UuzUBLE6gCtvtA8DB9MVjZUsgm4GUG7h4KLA88BA3KfdavmvBXVdGpvhkS4ekBNcEndy`).
  The SearchCatalog16/32/64 callbacks came back `AbortedComputation` (6000):
  they ran ~11 hours after queueing, after the job had already replaced the
  shared catalog for the next size, so this is read as a consequence of the
  delay, to be confirmed on the next prompt run.
- Of the 56 AA computations queued during the outage, 8 (the 11-07 07:30 JST
  run) are now `finalized`; 48 are still `queued`. Their rent is reclaimed by the
  job once Arcium expires them (`src/mxe/rent.ts`).

## What was ruled out

- **Cluster / version change:** the deployment guide still names devnet cluster
  `456`. Release notes: v0.16.0 (2026-10-23) needs no Arcis or account changes for
  existing applications ("Synchronize all Arcium dependencies, rebuild, and
  test"); only AES ciphers' nonce size changed (AA does not use them). Releases
  from v0.11 keep existing MXEs and accounts compatible. No migration step for
  existing devnet MXEs is documented. AA is on 0.15.0; callbacks to it work on
  the recovered cluster, so no upgrade is required to run. Moving to 0.16.0
  remains the documented way to keep components in sync.
- **AA's MXE state** (`utilityPubkeys` in the `unset` variant with keys filled,
  `keyRecoveryInitOffset` set): the same MXE executed before 11-06 and again on
  11-15 in this state, so it is not what stopped it.
- **A fresh hello-world MXE** was not deployed: a program deploy costs far more
  than the queuer key's ~0.35 devnet SOL, the key exists only in Railway, and the
  chain data above already separates the two cases (AA's own MXE ran once the
  cluster did).

## How AA handles it

- The breaker (`src/mxe/breaker.ts`) does not count runs inside this window
  (`KNOWN_OUTAGES`), so the functions are not paused for it.
- Rent of the stuck computations is reclaimed after expiry by the per-run sweep.

## Draft: note to Arcium (not sent)

> Subject: Devnet cluster 456 executed no computations 2026-11-06 22:21 → 11-15 09:51 UTC
>
> Hi Arcium team,
>
> Our MXE on devnet (program `B2nEZuSActZNBkcVPmo1eJeHQgToDmrHuBkZk52kZsUd`,
> cluster offset 456, @arcium-hq/client 0.15.0) had every computation stay
> `queued` from 2026-11-06 22:30 UTC until the cluster resumed on 2026-11-15
> around 09:51 UTC. From chain data, neither node's callback authority
> (`2fYMTn21…`, `5QPtFKv3…`) signed a successful callback for any program in
> that window (only 33 failed attempts on 11-09 to `D7g13sS8…`), while queue
> transactions kept arriving. Examples of our computations still `queued`:
>
> - queue tx `62KXNathRdk8AdLmnTWfyULe7dmdWypPd2zvxo2sHDbaz7YB2eSoMsCz5goMwBZAnSCXh9eh77XMCB3MVnhyWeW1`
>   (computation account `f2scp6szFsk2nVgDazgH8ZFtUgu74wYf1YqTm2dBM7x`, 2026-11-12 23:05 UTC)
> - queue tx `2DiCy2bajfJA898MUHSsDB7dA7niJMk62wpFhruP11VVv79mjChmFftdmiHtf5uCY7mCkMKR3nsAWp1M7xSojKfD`
>   (computation account `4DVQSy1qoxebJvrtXZ5L11pTKgaYWM1UV2oPf9KTWjno`, 2026-11-12 23:00 UTC)
> - queue tx `2RqbCLmP8YkhUvm6fvMxXZ3myScYtaUBZFNDLScVr9Zf1r1tjgJ3xx9neX5LW2RTPsEkMhygppbvJmvGrSs8E36Y`
>   (computation account `pPBkUUYK3Qe1DwN4bn7FJUiFDXvWPNSYmB49cdaLanP`, 2026-11-12 22:55 UTC)
>
> Callbacks to our program succeed again since 2026-11-15 09:52 UTC. Could you
> confirm:
>
> 1. the cause of the stop, and whether devnet maintenance like this is announced
>    somewhere we can watch;
> 2. whether computations queued during the stop will be executed, expired, or
>    should be reclaimed by us (`reclaim_expired_computation_fee`), and when
>    they count as expired;
> 3. whether devnet nodes now run v0.16.0, and whether an MXE on 0.15.0 is
>    expected to keep working there.
>
> Thank you.
