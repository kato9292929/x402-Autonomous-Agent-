//! AA × Arcium MXE program.
//!
//! Queues the circuits in `encrypted-ixs` and handles their callbacks. One
//! program holds every function so that one MXE — one deployment, one rent —
//! serves all of them.
//!
//! Function 1 — reservation-price matching (`Negotiation` PDA)
//!   seal_floor → match_ceiling. The floor lives encrypted in the PDA between
//!   the two calls; the result reveals `matched` and, only when matched, the
//!   midpoint price.
//!
//! Function 2 — sealed-quote RFQ (`Rfq` PDA)
//!   create_rfq → place_quote × n → close_rfq → award_rfq. The running minimum
//!   lives encrypted in the PDA; only the winner and the winning price leave
//!   MPC.
//!
//! Function 3 — seller scores without revealing the evaluator (`Scoreboard` PDA)
//!   create_scoreboard → submit_rating × n → reveal_scores. The board is a
//!   packed MXE-owned state; only per-seller aggregates are revealed.
//!
//! Function 4 — joint purchase without revealing the participants
//!   joint_purchase, one call with every buyer's sealed cap. Reveals `reached`;
//!   each buyer's share comes back encrypted to that buyer. Nothing persists.
//!
//! Function 5 — endpoint search without revealing the query (`Catalog` PDA)
//!   set_catalog (public, no MPC) → search_catalog_{8,16,32,64}. The result
//!   bitmask is encrypted to the querier.
//!
//! Calls on one PDA must be serialized: each computation reads the state the
//! previous callback wrote, so two queued at once would both read the same old
//! state and one update would be lost. The AA client awaits finalization before
//! queueing the next call. AA also submits every transaction itself (it is the
//! relayer), so on-chain metadata shows AA's signer rather than which seller
//! quoted — the sellers' identities stay inside the encrypted `Quote`.
//!
//! Started from arcium-hq/examples `sealed_bid_auction` (ISC); account layouts
//! and callback handling follow it. See ../../../README.md.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};

/// Where the Arx nodes fetch a circuit from.
///
/// Unset (localnet), the comp def falls back to the on-chain upload the tests
/// do. Set at build time — `AA_MXE_CIRCUIT_BASE_URL=https://… arcium build` —
/// it points at `{base}/{name}.arcis`, and the nodes check what they fetch
/// against the hash compiled in here, so the host cannot swap the circuit.
/// Storing every circuit on chain would cost tens of SOL in rent; off chain it
/// costs nothing.
macro_rules! circuit_source {
    ($name:literal) => {
        match option_env!("AA_MXE_CIRCUIT_BASE_URL") {
            Some(base) => Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: format!("{}/{}.arcis", base.trim_end_matches('/'), $name),
                hash: arcium_macros::circuit_hash!($name),
            })),
            None => None,
        }
    };
}

const COMP_DEF_OFFSET_SEAL_FLOOR: u32 = comp_def_offset("seal_floor");
const COMP_DEF_OFFSET_MATCH_CEILING: u32 = comp_def_offset("match_ceiling");
const COMP_DEF_OFFSET_OPEN_RFQ_STATE: u32 = comp_def_offset("open_rfq_state");
const COMP_DEF_OFFSET_PLACE_QUOTE: u32 = comp_def_offset("place_quote");
const COMP_DEF_OFFSET_AWARD_RFQ: u32 = comp_def_offset("award_rfq");
const COMP_DEF_OFFSET_OPEN_SCOREBOARD: u32 = comp_def_offset("open_scoreboard");
const COMP_DEF_OFFSET_SUBMIT_RATING: u32 = comp_def_offset("submit_rating");
const COMP_DEF_OFFSET_REVEAL_SCORES: u32 = comp_def_offset("reveal_scores");
const COMP_DEF_OFFSET_JOINT_PURCHASE: u32 = comp_def_offset("joint_purchase");
const COMP_DEF_OFFSET_SEARCH_CATALOG_8: u32 = comp_def_offset("search_catalog_8");
const COMP_DEF_OFFSET_SEARCH_CATALOG_16: u32 = comp_def_offset("search_catalog_16");
const COMP_DEF_OFFSET_SEARCH_CATALOG_32: u32 = comp_def_offset("search_catalog_32");
const COMP_DEF_OFFSET_SEARCH_CATALOG_64: u32 = comp_def_offset("search_catalog_64");

// Byte offsets of the encrypted state inside each PDA, passed to the circuit
// with `ArgBuilder::account` so the cluster reads it in place.
//
// Negotiation: 8 (discriminator) + 1 (bump) + 32 (authority) + 8 (id) +
//   1 (status) + 16 (floor_nonce) = 66, then one 32-byte ciphertext.
const NEGOTIATION_FLOOR_OFFSET: u32 = 66;
const NEGOTIATION_FLOOR_SIZE: u32 = 32;
// Rfq: 8 (discriminator) + 1 (bump) + 32 (authority) + 8 (id) + 1 (status) +
//   8 (end_time) + 2 (quote_count) + 16 (state_nonce) = 76, then four 32-byte
//   ciphertexts, one per field element of RfqState: lowest_amount,
//   lowest_seller lo/hi, quote_count.
const RFQ_STATE_OFFSET: u32 = 76;
const RFQ_STATE_SIZE: u32 = 32 * 4;
// Scoreboard: 8 (discriminator) + 1 (bump) + 32 (authority) + 8 (board_id) +
//   1 (status) + 4 (rating_count) + 16 (state_nonce) = 70, then the packed
//   board: Pack<[u32; 32]> is 6 field elements (counted with arcis' own packer).
const SCOREBOARD_STATE_OFFSET: u32 = 70;
const SCOREBOARD_STATE_SIZE: u32 = 32 * 6;
/// Largest catalog the search circuits take.
const CATALOG_MAX: usize = 64;

// Placeholder for localnet tests. The devnet deploy job replaces it with the
// program id derived from the deploy key, so the id is stable across deploys
// without a second secret.
declare_id!("Aw55u51PyWFsGN12dsZfHVjQ6eVqxoH1Teb6gbjmWVxJ");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum NegotiationStatus {
    FloorPending,
    FloorSealed,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RfqStatus {
    Opening,
    Open,
    Closed,
    Awarded,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ScoreboardStatus {
    Opening,
    Open,
}

#[arcium_program]
pub mod aa_mxe {
    use super::*;

    // ── Computation definitions ─────────────────────────────────────────────

    pub fn init_seal_floor_comp_def(ctx: Context<InitSealFloorCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("seal_floor"))?;
        Ok(())
    }

    pub fn init_match_ceiling_comp_def(ctx: Context<InitMatchCeilingCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("match_ceiling"))?;
        Ok(())
    }

    pub fn init_open_rfq_state_comp_def(ctx: Context<InitOpenRfqStateCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("open_rfq_state"))?;
        Ok(())
    }

    pub fn init_place_quote_comp_def(ctx: Context<InitPlaceQuoteCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("place_quote"))?;
        Ok(())
    }

    pub fn init_award_rfq_comp_def(ctx: Context<InitAwardRfqCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("award_rfq"))?;
        Ok(())
    }

    // ── Function 1: reservation-price matching ──────────────────────────────

    /// Creates the `Negotiation` PDA and queues `seal_floor` with the seller's
    /// encrypted floor. The floor is re-encrypted for the MXE in the callback.
    pub fn seal_floor(
        ctx: Context<SealFloor>,
        computation_offset: u64,
        negotiation_id: u64,
        encrypted_floor: [u8; 32],
        seller_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let negotiation = &mut ctx.accounts.negotiation;
        negotiation.bump = ctx.bumps.negotiation;
        negotiation.authority = ctx.accounts.authority.key();
        negotiation.negotiation_id = negotiation_id;
        negotiation.status = NegotiationStatus::FloorPending;
        negotiation.floor_nonce = 0;
        negotiation.encrypted_floor = [0u8; 32];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Enc<Shared, u64>: pubkey, nonce, then the single ciphertext.
        let args = ArgBuilder::new()
            .x25519_pubkey(seller_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_floor)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SealFloorCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.negotiation.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "seal_floor")]
    pub fn seal_floor_callback(
        ctx: Context<SealFloorCallback>,
        output: SignedComputationOutputs<SealFloorOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SealFloorOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let key = ctx.accounts.negotiation.key();
        let negotiation = &mut ctx.accounts.negotiation;
        negotiation.encrypted_floor = o.ciphertexts[0];
        negotiation.floor_nonce = o.nonce;
        negotiation.status = NegotiationStatus::FloorSealed;

        emit!(FloorSealedEvent {
            negotiation: key,
            negotiation_id: negotiation.negotiation_id,
        });
        Ok(())
    }

    /// Queues `match_ceiling` with the buyer's encrypted ceiling against the
    /// sealed floor.
    pub fn match_ceiling(
        ctx: Context<MatchCeiling>,
        computation_offset: u64,
        encrypted_ceiling: [u8; 32],
        buyer_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let negotiation = &ctx.accounts.negotiation;
        require!(
            negotiation.status == NegotiationStatus::FloorSealed,
            ErrorCode::FloorNotSealed
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Order must match the circuit: Enc<Shared, u64> (pubkey, nonce,
        // ciphertext), then Enc<Mxe, u64> (nonce, account data).
        let args = ArgBuilder::new()
            .x25519_pubkey(buyer_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_ceiling)
            .plaintext_u128(negotiation.floor_nonce)
            .account(
                ctx.accounts.negotiation.key(),
                NEGOTIATION_FLOOR_OFFSET,
                NEGOTIATION_FLOOR_SIZE,
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MatchCeilingCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.negotiation.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "match_ceiling")]
    pub fn match_ceiling_callback(
        ctx: Context<MatchCeilingCallback>,
        output: SignedComputationOutputs<MatchCeilingOutput>,
    ) -> Result<()> {
        let (matched, price) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(MatchCeilingOutput {
                field_0:
                    MatchCeilingOutputStruct0 {
                        field_0: matched,
                        field_1: price,
                    },
            }) => (matched, price),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let key = ctx.accounts.negotiation.key();
        let negotiation = &mut ctx.accounts.negotiation;
        negotiation.status = NegotiationStatus::Settled;

        emit!(NegotiationSettledEvent {
            negotiation: key,
            negotiation_id: negotiation.negotiation_id,
            matched,
            price,
        });
        Ok(())
    }

    // ── Function 2: sealed-quote RFQ ────────────────────────────────────────

    /// Creates the `Rfq` PDA and queues `open_rfq_state` for the initial
    /// encrypted state. Quotes are accepted until `end_time`.
    pub fn create_rfq(
        ctx: Context<CreateRfq>,
        computation_offset: u64,
        rfq_id: u64,
        duration: i64,
    ) -> Result<()> {
        let rfq = &mut ctx.accounts.rfq;
        rfq.bump = ctx.bumps.rfq;
        rfq.authority = ctx.accounts.authority.key();
        rfq.rfq_id = rfq_id;
        rfq.status = RfqStatus::Opening;
        rfq.end_time = Clock::get()?.unix_timestamp + duration;
        rfq.quote_count = 0;
        rfq.state_nonce = 0;
        rfq.encrypted_state = [[0u8; 32]; 4];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            ArgBuilder::new().build(),
            vec![OpenRfqStateCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.rfq.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "open_rfq_state")]
    pub fn open_rfq_state_callback(
        ctx: Context<OpenRfqStateCallback>,
        output: SignedComputationOutputs<OpenRfqStateOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(OpenRfqStateOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let key = ctx.accounts.rfq.key();
        let rfq = &mut ctx.accounts.rfq;
        rfq.encrypted_state = o.ciphertexts;
        rfq.state_nonce = o.nonce;
        rfq.status = RfqStatus::Open;

        emit!(RfqOpenedEvent {
            rfq: key,
            rfq_id: rfq.rfq_id,
            end_time: rfq.end_time,
        });
        Ok(())
    }

    /// Queues `place_quote` with one seller's encrypted quote and the current
    /// encrypted state.
    pub fn place_quote(
        ctx: Context<PlaceQuote>,
        computation_offset: u64,
        encrypted_seller_lo: [u8; 32],
        encrypted_seller_hi: [u8; 32],
        encrypted_amount: [u8; 32],
        seller_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let rfq = &ctx.accounts.rfq;
        require!(rfq.status == RfqStatus::Open, ErrorCode::RfqNotOpen);
        require!(
            Clock::get()?.unix_timestamp < rfq.end_time,
            ErrorCode::RfqEnded
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Enc<Shared, Quote> (pubkey, nonce, seller lo, seller hi, amount), then
        // Enc<Mxe, RfqState> (nonce, account data).
        let args = ArgBuilder::new()
            .x25519_pubkey(seller_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u128(encrypted_seller_lo)
            .encrypted_u128(encrypted_seller_hi)
            .encrypted_u64(encrypted_amount)
            .plaintext_u128(rfq.state_nonce)
            .account(ctx.accounts.rfq.key(), RFQ_STATE_OFFSET, RFQ_STATE_SIZE)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PlaceQuoteCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.rfq.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "place_quote")]
    pub fn place_quote_callback(
        ctx: Context<PlaceQuoteCallback>,
        output: SignedComputationOutputs<PlaceQuoteOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(PlaceQuoteOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let key = ctx.accounts.rfq.key();
        let rfq = &mut ctx.accounts.rfq;
        // Re-encrypted under a fresh nonce; persisting both is what lets the
        // next computation decrypt the account data.
        rfq.encrypted_state = o.ciphertexts;
        rfq.state_nonce = o.nonce;
        rfq.quote_count = rfq
            .quote_count
            .checked_add(1)
            .ok_or(ErrorCode::QuoteCountOverflow)?;

        emit!(QuotePlacedEvent {
            rfq: key,
            quote_count: rfq.quote_count,
        });
        Ok(())
    }

    /// Marks the RFQ `Closed` once `end_time` has passed. No MPC.
    pub fn close_rfq(ctx: Context<CloseRfq>) -> Result<()> {
        let rfq = &mut ctx.accounts.rfq;
        require!(rfq.status == RfqStatus::Open, ErrorCode::RfqNotOpen);
        require!(
            Clock::get()?.unix_timestamp >= rfq.end_time,
            ErrorCode::RfqNotEnded
        );
        rfq.status = RfqStatus::Closed;

        emit!(RfqClosedEvent {
            rfq: rfq.key(),
            quote_count: rfq.quote_count,
        });
        Ok(())
    }

    /// Queues `award_rfq`, which reveals only the winner and the winning price.
    pub fn award_rfq(ctx: Context<AwardRfq>, computation_offset: u64) -> Result<()> {
        let rfq = &ctx.accounts.rfq;
        require!(rfq.status == RfqStatus::Closed, ErrorCode::RfqNotClosed);
        require!(rfq.quote_count > 0, ErrorCode::NoQuotes);

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u128(rfq.state_nonce)
            .account(ctx.accounts.rfq.key(), RFQ_STATE_OFFSET, RFQ_STATE_SIZE)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AwardRfqCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.rfq.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "award_rfq")]
    pub fn award_rfq_callback(
        ctx: Context<AwardRfqCallback>,
        output: SignedComputationOutputs<AwardRfqOutput>,
    ) -> Result<()> {
        let (winner_lo, winner_hi, price) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(AwardRfqOutput {
                field_0:
                    AwardRfqOutputStruct0 {
                        field_0:
                            AwardRfqOutputStruct00 {
                                field_0: winner_lo,
                                field_1: winner_hi,
                            },
                        field_1: price,
                    },
            }) => (winner_lo, winner_hi, price),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // SerializedSolanaPublicKey arrives as lo/hi u128 halves, little-endian.
        let mut winner = [0u8; 32];
        winner[..16].copy_from_slice(&winner_lo.to_le_bytes());
        winner[16..].copy_from_slice(&winner_hi.to_le_bytes());

        let key = ctx.accounts.rfq.key();
        let rfq = &mut ctx.accounts.rfq;
        rfq.status = RfqStatus::Awarded;

        emit!(RfqAwardedEvent {
            rfq: key,
            rfq_id: rfq.rfq_id,
            winner,
            price,
        });
        Ok(())
    }
    // ── Functions 3–5: computation definitions ──────────────────────────────

    pub fn init_open_scoreboard_comp_def(ctx: Context<InitOpenScoreboardCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("open_scoreboard"))?;
        Ok(())
    }

    pub fn init_submit_rating_comp_def(ctx: Context<InitSubmitRatingCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("submit_rating"))?;
        Ok(())
    }

    pub fn init_reveal_scores_comp_def(ctx: Context<InitRevealScoresCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("reveal_scores"))?;
        Ok(())
    }

    pub fn init_joint_purchase_comp_def(ctx: Context<InitJointPurchaseCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("joint_purchase"))?;
        Ok(())
    }

    pub fn init_search_catalog_8_comp_def(ctx: Context<InitSearchCatalog8CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("search_catalog_8"))?;
        Ok(())
    }

    pub fn init_search_catalog_16_comp_def(ctx: Context<InitSearchCatalog16CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("search_catalog_16"))?;
        Ok(())
    }

    pub fn init_search_catalog_32_comp_def(ctx: Context<InitSearchCatalog32CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("search_catalog_32"))?;
        Ok(())
    }

    pub fn init_search_catalog_64_comp_def(ctx: Context<InitSearchCatalog64CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source!("search_catalog_64"))?;
        Ok(())
    }

    // ── Function 3: seller scores without revealing the evaluator ───────────

    /// Creates the `Scoreboard` PDA and queues `open_scoreboard` for the empty
    /// encrypted board.
    pub fn create_scoreboard(
        ctx: Context<CreateScoreboard>,
        computation_offset: u64,
        board_id: u64,
    ) -> Result<()> {
        let board = &mut ctx.accounts.scoreboard;
        board.bump = ctx.bumps.scoreboard;
        board.authority = ctx.accounts.authority.key();
        board.board_id = board_id;
        board.status = ScoreboardStatus::Opening;
        board.rating_count = 0;
        board.state_nonce = 0;
        board.encrypted_state = [[0u8; 32]; 6];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            ArgBuilder::new().build(),
            vec![OpenScoreboardCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.scoreboard.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "open_scoreboard")]
    pub fn open_scoreboard_callback(
        ctx: Context<OpenScoreboardCallback>,
        output: SignedComputationOutputs<OpenScoreboardOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(OpenScoreboardOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let key = ctx.accounts.scoreboard.key();
        let board = &mut ctx.accounts.scoreboard;
        board.encrypted_state = o.ciphertexts;
        board.state_nonce = o.nonce;
        board.status = ScoreboardStatus::Open;

        emit!(ScoreboardOpenedEvent {
            scoreboard: key,
            board_id: board.board_id,
        });
        Ok(())
    }

    /// Queues `submit_rating`. The slot (which seller) is encrypted along with
    /// the rating, so neither the values nor the target leave MPC.
    pub fn submit_rating(
        ctx: Context<SubmitRating>,
        computation_offset: u64,
        encrypted_slot: [u8; 32],
        encrypted_delivered: [u8; 32],
        encrypted_format_ok: [u8; 32],
        encrypted_latency_ms: [u8; 32],
        evaluator_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let board = &ctx.accounts.scoreboard;
        require!(
            board.status == ScoreboardStatus::Open,
            ErrorCode::ScoreboardNotOpen
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Enc<Shared, Rating> (pubkey, nonce, slot, delivered, format_ok,
        // latency_ms), then Enc<Mxe, Board> (nonce, account data).
        let args = ArgBuilder::new()
            .x25519_pubkey(evaluator_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_slot)
            .encrypted_bool(encrypted_delivered)
            .encrypted_bool(encrypted_format_ok)
            .encrypted_u32(encrypted_latency_ms)
            .plaintext_u128(board.state_nonce)
            .account(
                ctx.accounts.scoreboard.key(),
                SCOREBOARD_STATE_OFFSET,
                SCOREBOARD_STATE_SIZE,
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SubmitRatingCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.scoreboard.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "submit_rating")]
    pub fn submit_rating_callback(
        ctx: Context<SubmitRatingCallback>,
        output: SignedComputationOutputs<SubmitRatingOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SubmitRatingOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let key = ctx.accounts.scoreboard.key();
        let board = &mut ctx.accounts.scoreboard;
        board.encrypted_state = o.ciphertexts;
        board.state_nonce = o.nonce;
        board.rating_count = board
            .rating_count
            .checked_add(1)
            .ok_or(ErrorCode::RatingCountOverflow)?;

        emit!(RatingSubmittedEvent {
            scoreboard: key,
            rating_count: board.rating_count,
        });
        Ok(())
    }

    /// Queues `reveal_scores`, which reveals the per-seller aggregates only.
    pub fn reveal_scores(ctx: Context<RevealScores>, computation_offset: u64) -> Result<()> {
        let board = &ctx.accounts.scoreboard;
        require!(
            board.status == ScoreboardStatus::Open,
            ErrorCode::ScoreboardNotOpen
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u128(board.state_nonce)
            .account(
                ctx.accounts.scoreboard.key(),
                SCOREBOARD_STATE_OFFSET,
                SCOREBOARD_STATE_SIZE,
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealScoresCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.scoreboard.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_scores")]
    pub fn reveal_scores_callback(
        ctx: Context<RevealScoresCallback>,
        output: SignedComputationOutputs<RevealScoresOutput>,
    ) -> Result<()> {
        let (ratings, delivered, format_ok, latency_sum_ms) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealScoresOutput {
                field_0:
                    RevealScoresOutputStruct0 {
                        field_0: ratings,
                        field_1: delivered,
                        field_2: format_ok,
                        field_3: latency_sum_ms,
                    },
            }) => (ratings, delivered, format_ok, latency_sum_ms),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(ScoresRevealedEvent {
            scoreboard: ctx.accounts.scoreboard.key(),
            board_id: ctx.accounts.scoreboard.board_id,
            rating_count: ctx.accounts.scoreboard.rating_count,
            ratings,
            delivered,
            format_ok,
            latency_sum_ms,
        });
        Ok(())
    }

    // ── Function 4: joint purchase without revealing the participants ───────

    /// Queues `joint_purchase` with every buyer's sealed cap in one call. Each
    /// cap keeps its own owner key, which is what lets the circuit return each
    /// share encrypted to its own buyer.
    pub fn joint_purchase(
        ctx: Context<JointPurchase>,
        computation_offset: u64,
        encrypted_caps: [[u8; 32]; 3],
        buyer_pubkeys: [[u8; 32]; 3],
        nonces: [u128; 3],
        price: u32,
    ) -> Result<()> {
        require!(price > 0, ErrorCode::ZeroPrice);
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Caps and price are u32 micro-units (≈ 4,294 USDC max): the circuit
        // keeps every product in u64, which is what fits it under the CU limit.
        let mut args = ArgBuilder::new();
        for i in 0..3 {
            args = args
                .x25519_pubkey(buyer_pubkeys[i])
                .plaintext_u128(nonces[i])
                .encrypted_u32(encrypted_caps[i]);
        }
        let args = args.plaintext_u32(price).build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![JointPurchaseCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "joint_purchase")]
    pub fn joint_purchase_callback(
        ctx: Context<JointPurchaseCallback>,
        output: SignedComputationOutputs<JointPurchaseOutput>,
    ) -> Result<()> {
        let (reached, s0, s1, s2) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(JointPurchaseOutput {
                field_0:
                    JointPurchaseOutputStruct0 {
                        field_0: reached,
                        field_1: s0,
                        field_2: s1,
                        field_3: s2,
                    },
            }) => (reached, s0, s1, s2),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // The computation account identifies the call; the client knows which
        // offset it queued. No PDA is needed: nothing persists.
        emit!(JointPurchaseDecidedEvent {
            computation: ctx.accounts.computation_account.key(),
            reached,
            share_ciphertexts: [s0.ciphertexts[0], s1.ciphertexts[0], s2.ciphertexts[0]],
            share_nonces: [s0.nonce, s1.nonce, s2.nonce],
        });
        Ok(())
    }

    // ── Function 5: endpoint search without revealing the query ─────────────

    /// Writes the public catalog the search circuits read. Plain account, no
    /// MPC: the catalog is public by design, only the query is sealed.
    ///
    /// Stored on chain and read by the queue instruction, rather than passed
    /// in it, so the search transaction carries only the sealed query whatever
    /// the catalog size.
    pub fn set_catalog(
        ctx: Context<SetCatalog>,
        size: u8,
        version: u32,
        categories: Vec<u8>,
        formats: Vec<u8>,
        prices: Vec<u32>,
    ) -> Result<()> {
        require!(
            matches!(size, 8 | 16 | 32 | 64),
            ErrorCode::UnsupportedCatalogSize
        );
        let n = size as usize;
        require!(
            categories.len() == n && formats.len() == n && prices.len() == n,
            ErrorCode::CatalogLengthMismatch
        );

        let catalog = &mut ctx.accounts.catalog;
        catalog.bump = ctx.bumps.catalog;
        catalog.authority = ctx.accounts.authority.key();
        catalog.size = size;
        catalog.version = version;
        catalog.categories = [0; CATALOG_MAX];
        catalog.formats = [0; CATALOG_MAX];
        catalog.prices = [0; CATALOG_MAX];
        catalog.categories[..n].copy_from_slice(&categories);
        catalog.formats[..n].copy_from_slice(&formats);
        catalog.prices[..n].copy_from_slice(&prices);

        emit!(CatalogSetEvent {
            catalog: catalog.key(),
            size,
            version,
        });
        Ok(())
    }

    pub fn search_catalog_8(
        ctx: Context<SearchCatalog8>,
        computation_offset: u64,
        encrypted_category: [u8; 32],
        encrypted_format: [u8; 32],
        encrypted_max_price: [u8; 32],
        querier_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(ctx.accounts.catalog.size == 8, ErrorCode::CatalogSizeMismatch);
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = search_args(
            &ctx.accounts.catalog,
            8,
            querier_pubkey,
            nonce,
            encrypted_category,
            encrypted_format,
            encrypted_max_price,
        );
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SearchCatalog8Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "search_catalog_8")]
    pub fn search_catalog_8_callback(
        ctx: Context<SearchCatalog8Callback>,
        output: SignedComputationOutputs<SearchCatalog8Output>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SearchCatalog8Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        emit!(SearchResultEvent {
            computation: ctx.accounts.computation_account.key(),
            size: 8,
            ciphertext: o.ciphertexts[0],
            nonce: o.nonce,
        });
        Ok(())
    }

    pub fn search_catalog_16(
        ctx: Context<SearchCatalog16>,
        computation_offset: u64,
        encrypted_category: [u8; 32],
        encrypted_format: [u8; 32],
        encrypted_max_price: [u8; 32],
        querier_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(ctx.accounts.catalog.size == 16, ErrorCode::CatalogSizeMismatch);
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = search_args(
            &ctx.accounts.catalog,
            16,
            querier_pubkey,
            nonce,
            encrypted_category,
            encrypted_format,
            encrypted_max_price,
        );
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SearchCatalog16Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "search_catalog_16")]
    pub fn search_catalog_16_callback(
        ctx: Context<SearchCatalog16Callback>,
        output: SignedComputationOutputs<SearchCatalog16Output>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SearchCatalog16Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        emit!(SearchResultEvent {
            computation: ctx.accounts.computation_account.key(),
            size: 16,
            ciphertext: o.ciphertexts[0],
            nonce: o.nonce,
        });
        Ok(())
    }

    pub fn search_catalog_32(
        ctx: Context<SearchCatalog32>,
        computation_offset: u64,
        encrypted_category: [u8; 32],
        encrypted_format: [u8; 32],
        encrypted_max_price: [u8; 32],
        querier_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(ctx.accounts.catalog.size == 32, ErrorCode::CatalogSizeMismatch);
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = search_args(
            &ctx.accounts.catalog,
            32,
            querier_pubkey,
            nonce,
            encrypted_category,
            encrypted_format,
            encrypted_max_price,
        );
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SearchCatalog32Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "search_catalog_32")]
    pub fn search_catalog_32_callback(
        ctx: Context<SearchCatalog32Callback>,
        output: SignedComputationOutputs<SearchCatalog32Output>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SearchCatalog32Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        emit!(SearchResultEvent {
            computation: ctx.accounts.computation_account.key(),
            size: 32,
            ciphertext: o.ciphertexts[0],
            nonce: o.nonce,
        });
        Ok(())
    }

    pub fn search_catalog_64(
        ctx: Context<SearchCatalog64>,
        computation_offset: u64,
        encrypted_category: [u8; 32],
        encrypted_format: [u8; 32],
        encrypted_max_price: [u8; 32],
        querier_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(ctx.accounts.catalog.size == 64, ErrorCode::CatalogSizeMismatch);
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = search_args(
            &ctx.accounts.catalog,
            64,
            querier_pubkey,
            nonce,
            encrypted_category,
            encrypted_format,
            encrypted_max_price,
        );
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SearchCatalog64Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "search_catalog_64")]
    pub fn search_catalog_64_callback(
        ctx: Context<SearchCatalog64Callback>,
        output: SignedComputationOutputs<SearchCatalog64Output>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SearchCatalog64Output { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        emit!(SearchResultEvent {
            computation: ctx.accounts.computation_account.key(),
            size: 64,
            ciphertext: o.ciphertexts[0],
            nonce: o.nonce,
        });
        Ok(())
    }
}

// ── State ───────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Negotiation {
    pub bump: u8,
    pub authority: Pubkey,
    pub negotiation_id: u64,
    pub status: NegotiationStatus,
    pub floor_nonce: u128,
    pub encrypted_floor: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Rfq {
    pub bump: u8,
    pub authority: Pubkey,
    pub rfq_id: u64,
    pub status: RfqStatus,
    pub end_time: i64,
    pub quote_count: u16,
    pub state_nonce: u128,
    pub encrypted_state: [[u8; 32]; 4],
}

#[account]
#[derive(InitSpace)]
pub struct Scoreboard {
    pub bump: u8,
    pub authority: Pubkey,
    pub board_id: u64,
    pub status: ScoreboardStatus,
    pub rating_count: u32,
    pub state_nonce: u128,
    pub encrypted_state: [[u8; 32]; 6],
}

/// The public catalog function 5 searches. Only the first `size` entries are
/// read. Plaintext by design — the catalog is public; the query is not.
#[account]
#[derive(InitSpace)]
pub struct Catalog {
    pub bump: u8,
    pub authority: Pubkey,
    pub size: u8,
    pub version: u32,
    pub categories: [u8; CATALOG_MAX],
    pub formats: [u8; CATALOG_MAX],
    pub prices: [u32; CATALOG_MAX],
}

/// Search arguments in circuit order: Enc<Shared, SearchQuery> (pubkey,
/// nonce, category, format, max_price_micro), then the first `n` catalog
/// categories, formats and prices as plaintext.
///
/// u8 plaintext travels inline in the argument list; u32 prices use the
/// plaintext-number table, which an ArgumentRef indexes with a u8 — so at most
/// 256 of them. 64 is well inside that.
fn search_args(
    catalog: &Catalog,
    n: usize,
    querier_pubkey: [u8; 32],
    nonce: u128,
    encrypted_category: [u8; 32],
    encrypted_format: [u8; 32],
    encrypted_max_price: [u8; 32],
) -> ArgumentList {
    let mut args = ArgBuilder::new()
        .x25519_pubkey(querier_pubkey)
        .plaintext_u128(nonce)
        .encrypted_u8(encrypted_category)
        .encrypted_u8(encrypted_format)
        .encrypted_u32(encrypted_max_price);
    for i in 0..n {
        args = args.plaintext_u8(catalog.categories[i]);
    }
    for i in 0..n {
        args = args.plaintext_u8(catalog.formats[i]);
    }
    for i in 0..n {
        args = args.plaintext_u32(catalog.prices[i]);
    }
    args.build()
}

#[derive(Accounts)]
#[instruction(size: u8)]
pub struct SetCatalog<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Catalog::INIT_SPACE,
        seeds = [b"catalog", authority.key().as_ref(), &[size]],
        bump,
    )]
    pub catalog: Box<Account<'info, Catalog>>,
    pub system_program: Program<'info, System>,
}

// ── Function 1 accounts ─────────────────────────────────────────────────────

#[queue_computation_accounts("seal_floor", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, negotiation_id: u64)]
pub struct SealFloor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Negotiation::INIT_SPACE,
        seeds = [b"negotiation", authority.key().as_ref(), &negotiation_id.to_le_bytes()],
        bump,
    )]
    pub negotiation: Box<Account<'info, Negotiation>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEAL_FLOOR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("seal_floor")]
#[derive(Accounts)]
pub struct SealFloorCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEAL_FLOOR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub negotiation: Account<'info, Negotiation>,
}

#[queue_computation_accounts("match_ceiling", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct MatchCeiling<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub negotiation: Box<Account<'info, Negotiation>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_CEILING))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("match_ceiling")]
#[derive(Accounts)]
pub struct MatchCeilingCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_CEILING))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub negotiation: Account<'info, Negotiation>,
}

// ── Function 2 accounts ─────────────────────────────────────────────────────

#[queue_computation_accounts("open_rfq_state", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, rfq_id: u64)]
pub struct CreateRfq<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Rfq::INIT_SPACE,
        seeds = [b"rfq", authority.key().as_ref(), &rfq_id.to_le_bytes()],
        bump,
    )]
    pub rfq: Box<Account<'info, Rfq>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_OPEN_RFQ_STATE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("open_rfq_state")]
#[derive(Accounts)]
pub struct OpenRfqStateCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_OPEN_RFQ_STATE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

#[queue_computation_accounts("place_quote", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct PlaceQuote<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub rfq: Box<Account<'info, Rfq>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_QUOTE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("place_quote")]
#[derive(Accounts)]
pub struct PlaceQuoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_QUOTE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

#[derive(Accounts)]
pub struct CloseRfq<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub rfq: Account<'info, Rfq>,
}

#[queue_computation_accounts("award_rfq", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct AwardRfq<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub rfq: Box<Account<'info, Rfq>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_AWARD_RFQ))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("award_rfq")]
#[derive(Accounts)]
pub struct AwardRfqCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_AWARD_RFQ))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub rfq: Account<'info, Rfq>,
}

// ── Computation-definition initializers ─────────────────────────────────────

// Written out rather than generated by macro_rules!: the Arcium and Anchor
// tooling read these attributes, and the example spells them out too.

#[init_computation_definition_accounts("seal_floor", payer)]
#[derive(Accounts)]
pub struct InitSealFloorCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("match_ceiling", payer)]
#[derive(Accounts)]
pub struct InitMatchCeilingCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("open_rfq_state", payer)]
#[derive(Accounts)]
pub struct InitOpenRfqStateCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("place_quote", payer)]
#[derive(Accounts)]
pub struct InitPlaceQuoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("award_rfq", payer)]
#[derive(Accounts)]
pub struct InitAwardRfqCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}


// ── Functions 3–5 accounts (generated by the same template as the example's) ──

#[queue_computation_accounts("open_scoreboard", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, board_id: u64)]
pub struct CreateScoreboard<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Scoreboard::INIT_SPACE,
        seeds = [b"scoreboard", authority.key().as_ref(), &board_id.to_le_bytes()],
        bump,
    )]
    pub scoreboard: Box<Account<'info, Scoreboard>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_OPEN_SCOREBOARD))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("open_scoreboard")]
#[derive(Accounts)]
pub struct OpenScoreboardCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_OPEN_SCOREBOARD))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub scoreboard: Account<'info, Scoreboard>,
}

#[queue_computation_accounts("submit_rating", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitRating<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub scoreboard: Box<Account<'info, Scoreboard>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_RATING))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("submit_rating")]
#[derive(Accounts)]
pub struct SubmitRatingCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_RATING))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub scoreboard: Account<'info, Scoreboard>,
}

#[queue_computation_accounts("reveal_scores", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RevealScores<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub scoreboard: Box<Account<'info, Scoreboard>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_SCORES))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("reveal_scores")]
#[derive(Accounts)]
pub struct RevealScoresCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_SCORES))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub scoreboard: Account<'info, Scoreboard>,
}

#[queue_computation_accounts("joint_purchase", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct JointPurchase<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_JOINT_PURCHASE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("joint_purchase")]
#[derive(Accounts)]
pub struct JointPurchaseCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_JOINT_PURCHASE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[queue_computation_accounts("search_catalog_8", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SearchCatalog8<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::Unauthorized)]
    pub catalog: Box<Account<'info, Catalog>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_8))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("search_catalog_8")]
#[derive(Accounts)]
pub struct SearchCatalog8Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_8))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[queue_computation_accounts("search_catalog_16", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SearchCatalog16<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::Unauthorized)]
    pub catalog: Box<Account<'info, Catalog>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_16))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("search_catalog_16")]
#[derive(Accounts)]
pub struct SearchCatalog16Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_16))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[queue_computation_accounts("search_catalog_32", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SearchCatalog32<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::Unauthorized)]
    pub catalog: Box<Account<'info, Catalog>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_32))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("search_catalog_32")]
#[derive(Accounts)]
pub struct SearchCatalog32Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_32))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[queue_computation_accounts("search_catalog_64", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SearchCatalog64<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ ErrorCode::Unauthorized)]
    pub catalog: Box<Account<'info, Catalog>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_64))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("search_catalog_64")]
#[derive(Accounts)]
pub struct SearchCatalog64Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SEARCH_CATALOG_64))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[init_computation_definition_accounts("open_scoreboard", payer)]
#[derive(Accounts)]
pub struct InitOpenScoreboardCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("submit_rating", payer)]
#[derive(Accounts)]
pub struct InitSubmitRatingCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_scores", payer)]
#[derive(Accounts)]
pub struct InitRevealScoresCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("joint_purchase", payer)]
#[derive(Accounts)]
pub struct InitJointPurchaseCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("search_catalog_8", payer)]
#[derive(Accounts)]
pub struct InitSearchCatalog8CompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("search_catalog_16", payer)]
#[derive(Accounts)]
pub struct InitSearchCatalog16CompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("search_catalog_32", payer)]
#[derive(Accounts)]
pub struct InitSearchCatalog32CompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("search_catalog_64", payer)]
#[derive(Accounts)]
pub struct InitSearchCatalog64CompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct FloorSealedEvent {
    pub negotiation: Pubkey,
    pub negotiation_id: u64,
}

#[event]
pub struct NegotiationSettledEvent {
    pub negotiation: Pubkey,
    pub negotiation_id: u64,
    pub matched: bool,
    pub price: u64,
}

#[event]
pub struct RfqOpenedEvent {
    pub rfq: Pubkey,
    pub rfq_id: u64,
    pub end_time: i64,
}

#[event]
pub struct QuotePlacedEvent {
    pub rfq: Pubkey,
    pub quote_count: u16,
}

#[event]
pub struct RfqClosedEvent {
    pub rfq: Pubkey,
    pub quote_count: u16,
}

#[event]
pub struct RfqAwardedEvent {
    pub rfq: Pubkey,
    pub rfq_id: u64,
    pub winner: [u8; 32],
    pub price: u64,
}

#[event]
pub struct ScoreboardOpenedEvent {
    pub scoreboard: Pubkey,
    pub board_id: u64,
}

#[event]
pub struct RatingSubmittedEvent {
    pub scoreboard: Pubkey,
    pub rating_count: u32,
}

#[event]
pub struct ScoresRevealedEvent {
    pub scoreboard: Pubkey,
    pub board_id: u64,
    pub rating_count: u32,
    pub ratings: [u32; 8],
    pub delivered: [u32; 8],
    pub format_ok: [u32; 8],
    pub latency_sum_ms: [u32; 8],
}

#[event]
pub struct JointPurchaseDecidedEvent {
    pub computation: Pubkey,
    pub reached: bool,
    /// Buyer i's share, encrypted to buyer i. Only buyer i can read slot i.
    pub share_ciphertexts: [[u8; 32]; 3],
    pub share_nonces: [u128; 3],
}

#[event]
pub struct CatalogSetEvent {
    pub catalog: Pubkey,
    pub size: u8,
    pub version: u32,
}

#[event]
pub struct SearchResultEvent {
    pub computation: Pubkey,
    pub size: u8,
    /// Match bitmask, encrypted to the querier.
    pub ciphertext: [u8; 32],
    pub nonce: u128,
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Only the authority may do this")]
    Unauthorized,
    #[msg("The seller's floor has not been sealed yet")]
    FloorNotSealed,
    #[msg("The RFQ is not open")]
    RfqNotOpen,
    #[msg("The RFQ deadline has passed")]
    RfqEnded,
    #[msg("The RFQ deadline has not passed yet")]
    RfqNotEnded,
    #[msg("The RFQ is not closed")]
    RfqNotClosed,
    #[msg("The RFQ received no quotes")]
    NoQuotes,
    #[msg("Quote count overflow")]
    QuoteCountOverflow,
    #[msg("The scoreboard is not open")]
    ScoreboardNotOpen,
    #[msg("Rating count overflow")]
    RatingCountOverflow,
    #[msg("Catalog size must be 8, 16, 32 or 64")]
    UnsupportedCatalogSize,
    #[msg("Catalog arrays must each have `size` entries")]
    CatalogLengthMismatch,
    #[msg("This search instruction is for a different catalog size")]
    CatalogSizeMismatch,
    #[msg("A joint purchase needs a price above zero")]
    ZeroPrice,
}
