/**
 * Manual x402 payment flow for Solana.
 * withX402 does not support Solana, so we implement the 402 challenge/response
 * loop manually using Circle Developer-Controlled Wallets for USDC transfer.
 *
 * Flow:
 *   1. Send initial request → expect 402
 *   2. Parse payment requirements from 402 body (x402 v2) or header fallback (v1)
 *   3. Create Solana USDC transfer via Circle DCW
 *   4. Wait for transaction signature
 *   5. Retry request with X-PAYMENT-RESPONSE / PAYMENT-RESPONSE proof header
 */
import { createSolanaTransfer, waitForSolanaSignature } from "./circle/transfer";

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

export async function parsePaymentRequired(response: Response): Promise<SolanaPaymentRequirements | null> {
  // x402 v2: payment requirements are in the response body
  // { x402Version: 2, accepts: [{ scheme, network, payTo, amount, asset }] }
  try {
    const body = await response.json() as {
      x402Version?: number;
      accepts?: SolanaPaymentRequirements[];
    };
    if (Array.isArray(body?.accepts)) {
      const req = body.accepts.find(
        (r) => typeof r.network === "string" && r.network.toLowerCase().includes("solana")
      );
      if (req) return req;
    }
  } catch {
    // body not JSON — fall through to header fallback
  }

  // Fallback: header-based (v1 servers or non-standard implementations)
  const header =
    response.headers.get("PAYMENT-REQUIRED") ??
    response.headers.get("X-PAYMENT-REQUIRED");
  if (!header) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf-8"));
  } catch {
    try {
      decoded = JSON.parse(header);
    } catch {
      console.warn("[SOLANA] Failed to parse PAYMENT-REQUIRED header");
      return null;
    }
  }

  if (Array.isArray(decoded)) {
    // v1 header format: array of requirements directly
    const req = (decoded as SolanaPaymentRequirements[]).find(
      (r) => typeof r.network === "string" && r.network.toLowerCase().includes("solana")
    );
    return req ?? null;
  }

  // v2 header format: { x402Version, accepts: [...] } — same shape as body but delivered via header
  const obj = decoded as { accepts?: SolanaPaymentRequirements[]; network?: string };
  if (Array.isArray(obj?.accepts)) {
    const req = obj.accepts.find(
      (r) => typeof r.network === "string" && r.network.toLowerCase().includes("solana")
    );
    return req ?? null;
  }

  // v1 single-object format: decoded object IS the requirement
  if (obj?.network?.toLowerCase().includes("solana")) return obj as SolanaPaymentRequirements;

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

  // Step 2: parse challenge (x402 v2 body, with header fallback)
  const req = await parsePaymentRequired(firstRes);
  if (!req) {
    throw new Error(`[SOLANA] 402 received but no Solana payment requirements found (url: ${urlStr})`);
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
  const { transactionId } = await createSolanaTransfer({
    walletId: config.walletId,
    destinationAddress: req.payTo,
    amountDecimal,
  });

  // Step 4: wait for Solana transaction signature
  const signature = await waitForSolanaSignature(transactionId);

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
