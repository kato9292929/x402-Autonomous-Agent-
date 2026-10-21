//! AA × Arcium MXE circuits.
//!
//! Every function here exists to prove one trade that does not work unless the
//! inputs stay sealed: a party hands the MXE a number it would not show the
//! other side, and only the outcome comes back out.
//!
//! Function 1 — reservation-price matching
//!   The seller seals its floor into MXE-owned state; the buyer's ceiling is then
//!   compared against it. On overlap the midpoint is revealed; otherwise nothing
//!   is, beyond "no deal".
//!
//! Function 2 — sealed-quote RFQ
//!   Each seller's quote is folded into MXE-owned state as it arrives. After the
//!   deadline only the winner (lowest quote) and the winning price are revealed.
//!   Losing quotes never leave MPC.
//!
//! Function 3 — seller scores without revealing the evaluator
//!   Each rating (delivered / format / latency) is folded into a packed,
//!   MXE-owned scoreboard; every slot is touched on every call, so even which
//!   seller was rated stays hidden. Only per-seller aggregates are revealed.
//!
//! Function 4 — joint purchase without revealing the participants
//!   Buyers seal their caps; the MXE reveals only whether together they reach
//!   the price, and returns each buyer's pro-rata share encrypted to that buyer.
//!
//! Function 5 — endpoint search without revealing the query
//!   A sealed query is matched against a public catalog; the matching entries
//!   come back as a bitmask encrypted to the querier. One circuit per catalog
//!   size (8 / 16 / 32 / 64) so the cost can be measured against N.
//!
//! Started from arcium-hq/examples `sealed_bid_auction` (ISC); see ../../README.md.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // ── Function 1: reservation-price matching ─────────────────────────────

    pub struct NegotiationResult {
        pub matched: bool,
        /// Midpoint of floor and ceiling when matched, 0 otherwise.
        pub price: u64,
    }

    /// The seller's floor, re-encrypted for the MXE so a later computation can
    /// read it without the buyer ever seeing it. Reveals nothing.
    #[instruction]
    pub fn seal_floor(floor_ctxt: Enc<Shared, u64>) -> Enc<Mxe, u64> {
        let floor = floor_ctxt.to_arcis();
        Mxe::get().from_arcis(floor)
    }

    /// Compares the buyer's ceiling with the sealed floor.
    ///
    /// The midpoint is computed without subtraction. Both branches of an `if`
    /// are evaluated in MPC, so `ceiling - floor` would also be computed when
    /// ceiling < floor and underflow; `(a & b) + ((a ^ b) >> 1)` is the
    /// overflow-free average and needs no branch at all.
    ///
    /// Known property of the midpoint rule, recorded rather than hidden: on a
    /// match, either side can recover the other's value as `2 * price - own`
    /// (±1 for rounding). Secrecy holds for failed negotiations, not for the
    /// value behind a successful one.
    #[instruction]
    pub fn match_ceiling(ceiling_ctxt: Enc<Shared, u64>, floor_ctxt: Enc<Mxe, u64>) -> NegotiationResult {
        let ceiling = ceiling_ctxt.to_arcis();
        let floor = floor_ctxt.to_arcis();
        let matched = ceiling >= floor;
        let midpoint = (floor & ceiling) + ((floor ^ ceiling) >> 1);
        let price = if matched { midpoint } else { 0 };
        NegotiationResult { matched, price }.reveal()
    }

    // ── Function 2: sealed-quote RFQ ───────────────────────────────────────

    pub struct Quote {
        pub seller: SerializedSolanaPublicKey,
        pub amount: u64,
    }

    pub struct RfqState {
        pub lowest_amount: u64,
        pub lowest_seller: SerializedSolanaPublicKey,
        pub quote_count: u16,
    }

    pub struct RfqAward {
        pub winner: SerializedSolanaPublicKey,
        /// The winning (lowest) quote. `u64::MAX` means no quote arrived.
        pub price: u64,
    }

    /// Empty RFQ state, encrypted for the MXE. `lowest_amount` starts at the
    /// maximum so the first quote always becomes the lowest. Reveals nothing.
    #[instruction]
    pub fn open_rfq_state() -> Enc<Mxe, RfqState> {
        let initial = RfqState {
            lowest_amount: u64::MAX,
            lowest_seller: SerializedSolanaPublicKey { lo: 0, hi: 0 },
            quote_count: 0,
        };
        Mxe::get().from_arcis(initial)
    }

    /// Folds one quote into the running minimum. Reveals nothing; the state is
    /// re-encrypted for the MXE. Ties keep the earlier quote (strict `<`).
    #[instruction]
    pub fn place_quote(quote_ctxt: Enc<Shared, Quote>, state_ctxt: Enc<Mxe, RfqState>) -> Enc<Mxe, RfqState> {
        let quote = quote_ctxt.to_arcis();
        let mut state = state_ctxt.to_arcis();
        if quote.amount < state.lowest_amount {
            state.lowest_amount = quote.amount;
            state.lowest_seller = quote.seller;
        }
        state.quote_count += 1;
        state_ctxt.owner.from_arcis(state)
    }

    /// Reveals the winner and the winning price, and nothing about the losers.
    #[instruction]
    pub fn award_rfq(state_ctxt: Enc<Mxe, RfqState>) -> RfqAward {
        let state = state_ctxt.to_arcis();
        RfqAward {
            winner: state.lowest_seller,
            price: state.lowest_amount,
        }
        .reveal()
    }

    // ── Function 3: seller scores without revealing the evaluator ──────────

    /// Seller slots on the scoreboard. Slot → seller is public configuration;
    /// which slot a given rating is for stays encrypted.
    pub const SCORE_SLOTS: usize = 8;
    /// Latency is clamped so the per-slot sum cannot overflow a u32.
    pub const LATENCY_CAP_MS: u32 = 60_000;

    pub struct Rating {
        pub slot: u8,
        pub delivered: bool,
        pub format_ok: bool,
        pub latency_ms: u32,
    }

    /// Board layout, one packed array (Arcis packs a bare `Pack<[T; N]>`, not
    /// one nested in a struct — that is how arcium-hq/examples `blackjack`
    /// uses it too):
    ///   [0..8)   ratings
    ///   [8..16)  delivered
    ///   [16..24) format_ok
    ///   [24..32) latency_sum_ms
    ///
    /// Unpacked this would be 32 field elements, a 1040-byte
    /// `MXEEncryptedStruct<32>` the callback transaction cannot carry (Solana
    /// caps a transaction at 1232 bytes, signatures and accounts included).
    /// Packed it is 6 elements (counted with arcis' own packer, not estimated),
    /// a 208-byte `MXEEncryptedStruct<6>`.
    pub const BOARD_LEN: usize = 4 * SCORE_SLOTS;
    type Board = Pack<[u32; BOARD_LEN]>;

    /// What `reveal_scores` returns, in plaintext. Revealed values travel at
    /// their own width, so this is 128 bytes and needs no packing.
    pub struct ScoreReport {
        pub ratings: [u32; SCORE_SLOTS],
        pub delivered: [u32; SCORE_SLOTS],
        pub format_ok: [u32; SCORE_SLOTS],
        pub latency_sum_ms: [u32; SCORE_SLOTS],
    }

    /// An empty scoreboard, encrypted for the MXE. Reveals nothing.
    #[instruction]
    pub fn open_scoreboard() -> Enc<Mxe, Board> {
        Mxe::get().from_arcis(Pack::new([0u32; BOARD_LEN]))
    }

    /// Folds one rating into the board. Every slot is touched on every call —
    /// that is what keeps the rated seller secret, not just the values. Reveals
    /// nothing.
    #[instruction]
    pub fn submit_rating(rating_ctxt: Enc<Shared, Rating>, board_ctxt: Enc<Mxe, Board>) -> Enc<Mxe, Board> {
        let r = rating_ctxt.to_arcis();
        let mut b: [u32; BOARD_LEN] = board_ctxt.to_arcis().unpack();
        let latency = if r.latency_ms > LATENCY_CAP_MS { LATENCY_CAP_MS } else { r.latency_ms };
        for i in 0..SCORE_SLOTS {
            let hit = r.slot == i as u8;
            b[i] += hit as u32;
            b[SCORE_SLOTS + i] += (hit && r.delivered) as u32;
            b[2 * SCORE_SLOTS + i] += (hit && r.format_ok) as u32;
            b[3 * SCORE_SLOTS + i] += if hit { latency } else { 0 };
        }
        board_ctxt.owner.from_arcis(Pack::new(b))
    }

    /// Reveals the per-seller aggregates — and only those. With a single
    /// evaluator the aggregate IS that evaluator's rating, so the secrecy this
    /// buys is not measurable until other buyers submit too.
    #[instruction]
    pub fn reveal_scores(board_ctxt: Enc<Mxe, Board>) -> ScoreReport {
        let b: [u32; BOARD_LEN] = board_ctxt.to_arcis().unpack();
        let mut report = ScoreReport {
            ratings: [0; SCORE_SLOTS],
            delivered: [0; SCORE_SLOTS],
            format_ok: [0; SCORE_SLOTS],
            latency_sum_ms: [0; SCORE_SLOTS],
        };
        for i in 0..SCORE_SLOTS {
            report.ratings[i] = b[i];
            report.delivered[i] = b[SCORE_SLOTS + i];
            report.format_ok[i] = b[2 * SCORE_SLOTS + i];
            report.latency_sum_ms[i] = b[3 * SCORE_SLOTS + i];
        }
        report.reveal()
    }

    // ── Function 4: joint purchase without revealing the participants ──────

    /// Buyers per joint purchase. A buyer who does not take part submits 0.
    pub const JOINT_BUYERS: usize = 3;

    /// Fixed-point scale of the pro-rata ratio: `ratio = floor(price · 2^24 / sum)`.
    const SHARE_SCALE_BITS: usize = 24;

    /// Decides whether the buyers' caps together reach the seller's price and,
    /// if so, what each pays.
    ///
    /// Caps, price and shares are u32 micro-units (up to ≈ 4,294 USDC), so every
    /// intermediate fits in u64. Secret division is what makes MPC circuits
    /// heavy — three u128 divisions put this circuit over Arcium's per-circuit
    /// CU limit — so the pro-rata ratio is divided once, and each share is a
    /// multiply and a shift by a public constant:
    ///
    ///   share_i = ceil(cap_i · ratio / 2^24)
    ///
    /// Because `ratio <= price / sum`, each share is at most `ceil(cap_i · price
    /// / sum)` and so at most its own cap. Truncating the ratio can leave the
    /// total a few units short of the price; that deficit is then taken from
    /// the buyers' remaining headroom in order (it exists, since sum >= price).
    /// The total is at least the price and over by fewer than JOINT_BUYERS
    /// micro-units. A buyer with cap 0 pays 0.
    ///
    /// Revealed: only `reached`. Each share is encrypted to its own buyer, so
    /// no buyer — and not the seller — learns who else took part or for how
    /// much. A buyer can still infer the SUM of the others' caps from its own
    /// share; that is the pro-rata rule. Settlement is a separate layer: if each
    /// buyer pays the seller directly on a public chain, the payments
    /// themselves show who paid.
    #[instruction]
    pub fn joint_purchase(
        cap_0: Enc<Shared, u32>,
        cap_1: Enc<Shared, u32>,
        cap_2: Enc<Shared, u32>,
        price: u32,
    ) -> (bool, Enc<Shared, u32>, Enc<Shared, u32>, Enc<Shared, u32>) {
        let caps = [
            cap_0.to_arcis() as u64,
            cap_1.to_arcis() as u64,
            cap_2.to_arcis() as u64,
        ];
        let price = price as u64;
        let mut sum: u64 = 0;
        for i in 0..JOINT_BUYERS {
            sum += caps[i];
        }
        let reached = sum >= price;
        // Divide by sum on success; otherwise by price, which keeps the ratio
        // (and every product below) in range — those shares are masked anyway.
        let denom = if reached { sum } else { price };
        let denom = if denom == 0 { 1 } else { denom };
        let ratio = (price << SHARE_SCALE_BITS) / denom;
        let round_up: u64 = (1 << SHARE_SCALE_BITS) - 1;

        let mut shares: [u64; JOINT_BUYERS] = [0; JOINT_BUYERS];
        let mut total: u64 = 0;
        for i in 0..JOINT_BUYERS {
            shares[i] = (caps[i] * ratio + round_up) >> SHARE_SCALE_BITS;
            total += shares[i];
        }
        let mut deficit = if price > total { price - total } else { 0 };
        for i in 0..JOINT_BUYERS {
            let headroom = caps[i] - shares[i];
            let add = if deficit < headroom { deficit } else { headroom };
            shares[i] += add;
            deficit -= add;
        }
        for i in 0..JOINT_BUYERS {
            shares[i] = if reached { shares[i] } else { 0 };
        }
        (
            reached.reveal(),
            cap_0.owner.from_arcis(shares[0] as u32),
            cap_1.owner.from_arcis(shares[1] as u32),
            cap_2.owner.from_arcis(shares[2] as u32),
        )
    }

    // ── Function 5: endpoint search without revealing the query ────────────

    pub struct SearchQuery {
        pub category: u8,
        /// 0 matches any format.
        pub format: u8,
        pub max_price_micro: u32,
    }

    /// Bit i of the result is set when catalog entry i matches. The catalog is
    /// public (plaintext); the query and the result are not — the result is
    /// encrypted to whoever asked.
    ///
    /// The weight doubles each iteration rather than shifting by `i`: Arcis
    /// shifts need a compile-time amount, and a running weight needs neither a
    /// shift nor a branch.
    fn search<const N: usize>(
        q: &SearchQuery,
        categories: &[u8; N],
        formats: &[u8; N],
        prices: &[u32; N],
    ) -> u64 {
        let mut mask: u64 = 0;
        let mut weight: u64 = 1;
        for i in 0..N {
            let ok = categories[i] == q.category
                && (q.format == 0 || formats[i] == q.format)
                && prices[i] <= q.max_price_micro;
            mask += if ok { weight } else { 0 };
            weight = weight * 2;
        }
        mask
    }

    // One circuit per catalog size, so the cost of the same query can be
    // measured against N. Each is its own computation definition.

    #[instruction]
    pub fn search_catalog_8(q_ctxt: Enc<Shared, SearchQuery>, categories: [u8; 8], formats: [u8; 8], prices: [u32; 8]) -> Enc<Shared, u64> {
        let q = q_ctxt.to_arcis();
        q_ctxt.owner.from_arcis(search(&q, &categories, &formats, &prices))
    }

    #[instruction]
    pub fn search_catalog_16(q_ctxt: Enc<Shared, SearchQuery>, categories: [u8; 16], formats: [u8; 16], prices: [u32; 16]) -> Enc<Shared, u64> {
        let q = q_ctxt.to_arcis();
        q_ctxt.owner.from_arcis(search(&q, &categories, &formats, &prices))
    }

    #[instruction]
    pub fn search_catalog_32(q_ctxt: Enc<Shared, SearchQuery>, categories: [u8; 32], formats: [u8; 32], prices: [u32; 32]) -> Enc<Shared, u64> {
        let q = q_ctxt.to_arcis();
        q_ctxt.owner.from_arcis(search(&q, &categories, &formats, &prices))
    }

    #[instruction]
    pub fn search_catalog_64(q_ctxt: Enc<Shared, SearchQuery>, categories: [u8; 64], formats: [u8; 64], prices: [u32; 64]) -> Enc<Shared, u64> {
        let q = q_ctxt.to_arcis();
        q_ctxt.owner.from_arcis(search(&q, &categories, &formats, &prices))
    }
}
