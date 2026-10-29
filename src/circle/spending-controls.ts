/**
 * Spending controls for x402 payments.
 * Per-call USDC ceiling enforced by the payment-selection policy in src/x402.ts
 * (withinMicroUsdcCap): the agent transacts autonomously but only within this limit.
 */

export const DEFAULT_MAX_BASE_MICRO_USDC = BigInt(3_000_000); // $3.00 (covers Mode C weekly)
