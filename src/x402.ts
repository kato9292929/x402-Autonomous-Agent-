/**
 * x402 fetch initialization for Base (EVM) payments.
 *
 * SIGNER_BACKEND env var selects the signing backend:
 *   "circle"     — Circle Developer-Controlled Wallet (CIRCLE_EVM_WALLET_ID + CIRCLE_EVM_WALLET_ADDRESS)
 *   "privatekey" — Local EOA private key (PAYMENT_PRIVATE_KEY)  ← default
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "@x402/core/types";
import { getCircleEvmSignerFromEnv } from "./circle/evm-signer";
import { DEFAULT_MAX_BASE_MICRO_USDC } from "./circle/spending-controls";

let _fetchWithPayment:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

function buildEvmScheme(): ExactEvmScheme {
  const backend = process.env.SIGNER_BACKEND ?? "privatekey";

  if (backend === "circle") {
    console.log("[X402] Using Circle DCW signer for Base (SIGNER_BACKEND=circle)");
    const signer = getCircleEvmSignerFromEnv();
    console.log(`[X402] Circle EVM wallet: ${signer.address}`);
    return new ExactEvmScheme(signer);
  }

  // default: privatekey
  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "PAYMENT_PRIVATE_KEY is required when SIGNER_BACKEND=privatekey (default). " +
      "Set SIGNER_BACKEND=circle to use Circle DCW instead."
    );
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`[X402] Using private key signer for Base: ${account.address}`);
  // toClientEvmSigner adapts LocalAccount to ClientEvmSigner (address + signTypedData)
  return new ExactEvmScheme(toClientEvmSigner(account));
}

export async function initX402Fetch(): Promise<void> {
  const evmScheme = buildEvmScheme();
  const maxUsdc = DEFAULT_MAX_BASE_MICRO_USDC;

  const client = new x402Client()
    // v2 servers: CAIP-2 network identifier
    .register("eip155:8453", evmScheme)
    // v1 servers: legacy network name ("base") — keeps old endpoints working
    .registerV1("base", evmScheme)
    // Block requests priced above our cap
    .registerPolicy(
      (_version: number, reqs: PaymentRequirements[]) =>
        reqs.filter((r) => {
          try {
            return BigInt(r.amount) <= maxUsdc;
          } catch {
            return false;
          }
        })
    );

  _fetchWithPayment = wrapFetchWithPayment(fetch, client);
}

export function fetchWithPayment(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (!_fetchWithPayment) {
    throw new Error("x402 fetch not initialized. Call initX402Fetch() first.");
  }
  return _fetchWithPayment(input, init);
}
