/**
 * Manual x402 payment flow for Solana.
 * withX402 does not support Solana, so we implement the 402 challenge/response
 * loop manually using Circle Developer-Controlled Wallets for USDC transfer.
 *
 * Flow:
 *   1. Send initial request → expect 402
 *   2. Parse PAYMENT-REQUIRED header for payTo / amount
 *   3. Create Solana USDC transfer via Circle DCW
 *   4. Wait for transaction signature
 *   5. Retry request with X-PAYMENT-RESPONSE / PAYMENT-RESPONSE proof header
 */
import { createCircleTransfer, waitForTransactionSignature } from "./circle";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SolanaPaymentRequirements {
  scheme: string;
  network: string;
  payTo: string;
  amount?: string;           // v2 field (micro-USDC, 6 decimals)
  maxAmountRequired?: string; // v1 compat
  asset?: string;
  resource?: string;
}

export interface SolanaFetchConfig {
  walletId: string;
  walletAddress: string;
  maxMicroUsdc: bigint;
}

// ── Utilities (exported for testing) ─────────────────────────────────────────

export function microUsdcToDecimal(microUsdc: string | bigint): string {
  const n = BigInt(microUsdc);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  return `${whole}.${String(frac).padStart(6, "0")}`;
}

export function parsePaymentRequired(response: Response): SolanaPaymentRequirements | null {
  const header =
    response.headers.get("PAYMENT-REQUIRED") ??
    response.headers.get("X-PAYMENT-REQUIRED");
  if (!header) return null;

  let decoded: unknown;
  try {
    // v2: base64url-encoded JSON
    decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf-8"));
  } catch {
    try {
      // v1: plain JSON string
      decoded = JSON.parse(header);
    } catch {
      console.warn("[SOLANA] Failed to parse PAYMENT-REQUIRED header");
      return null;
    }
  }

  // Array format (v2): find first Solana requirement
  if (Array.isArray(decoded)) {
    const req = (decoded as SolanaPaymentRequirements[]).find(
      (r) => typeof r.network === "string" && r.network.toLowerCase().includes("solana")
    );
    return req ?? null;
  }

  // Object format (v1)
  const obj = decoded as SolanaPaymentRequirements;
  if (obj?.network?.toLowerCase().includes("solana")) return obj;

  return null;
}

export function buildPaymentProofHeader(
  signature: string,
  walletAddress: string,
  req: SolanaPaymentRequirements
): string {
  const proof = {
    x402Version: 1,
    scheme: req.scheme,
    network: req.network,
    payload: {
      signature,
      from: walletAddress,
    },
  };
  return Buffer.from(JSON.stringify(proof)).toString("base64url");
}

// ── Main fetch wrapper ────────────────────────────────────────────────────────

export async function fetchWithSolanaPayment(
  url: string | URL,
  init: RequestInit | undefined,
  config: SolanaFetchConfig
): Promise<Response> {
  const urlStr = url.toString();

  // Step 1: initial request
  console.log(`[SOLANA] Initial request → ${urlStr}`);
  const firstRes = await fetch(url, init);

  if (firstRes.status !== 402) {
    // Not a payment challenge (success or unexpected error)
    return firstRes;
  }

  // Step 2: parse challenge
  const req = parsePaymentRequired(firstRes);
  if (!req) {
    throw new Error(`[SOLANA] 402 received but no Solana payment requirements in headers (url: ${urlStr})`);
  }

  const rawAmount = req.amount ?? req.maxAmountRequired ?? "0";
  const amountMicro = BigInt(rawAmount);
  if (amountMicro === 0n) {
    throw new Error(`[SOLANA] Payment amount is 0 or missing in challenge (url: ${urlStr})`);
  }
  if (amountMicro > config.maxMicroUsdc) {
    throw new Error(
      `[SOLANA] Payment amount ${amountMicro} µUSDC exceeds max ${config.maxMicroUsdc} µUSDC (url: ${urlStr})`
    );
  }

  const amountDecimal = microUsdcToDecimal(amountMicro);
  console.log(
    `[SOLANA] Challenge parsed — payTo: ${req.payTo}, amount: ${amountDecimal} USDC, network: ${req.network}`
  );

  // Step 3: send USDC via Circle DCW
  const { transactionId } = await createCircleTransfer({
    walletId: config.walletId,
    destinationAddress: req.payTo,
    amountDecimal,
  });

  // Step 4: wait for Solana transaction signature
  const signature = await waitForTransactionSignature(transactionId);

  // Step 5: retry with proof header
  const proofHeader = buildPaymentProofHeader(signature, config.walletAddress, req);
  const headers = new Headers(init?.headers);
  headers.set("X-PAYMENT-RESPONSE", proofHeader);
  headers.set("PAYMENT-RESPONSE", proofHeader);

  console.log(`[SOLANA] Retrying with payment proof — signature: ${signature.slice(0, 20)}...`);
  const secondRes = await fetch(url, { ...init, headers });
  console.log(`[SOLANA] Second response: HTTP ${secondRes.status} (url: ${urlStr})`);

  return secondRes;
}
