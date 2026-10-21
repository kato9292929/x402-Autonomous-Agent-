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
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_SEAL_FLOOR: u32 = comp_def_offset("seal_floor");
const COMP_DEF_OFFSET_MATCH_CEILING: u32 = comp_def_offset("match_ceiling");
const COMP_DEF_OFFSET_OPEN_RFQ_STATE: u32 = comp_def_offset("open_rfq_state");
const COMP_DEF_OFFSET_PLACE_QUOTE: u32 = comp_def_offset("place_quote");
const COMP_DEF_OFFSET_AWARD_RFQ: u32 = comp_def_offset("award_rfq");

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

#[arcium_program]
pub mod aa_mxe {
    use super::*;

    // ── Computation definitions ─────────────────────────────────────────────

    pub fn init_seal_floor_comp_def(ctx: Context<InitSealFloorCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_match_ceiling_comp_def(ctx: Context<InitMatchCeilingCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_open_rfq_state_comp_def(ctx: Context<InitOpenRfqStateCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_place_quote_comp_def(ctx: Context<InitPlaceQuoteCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_award_rfq_comp_def(ctx: Context<InitAwardRfqCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
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
}
