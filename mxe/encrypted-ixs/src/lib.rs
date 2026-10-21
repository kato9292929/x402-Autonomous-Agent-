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
}
