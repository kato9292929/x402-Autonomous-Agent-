import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "@x402/core/types";

const MAX_USDC = BigInt(3_000_000); // $3.00 USDC (6 decimals) — covers weekly $3.00 reports

let _fetchWithPayment:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

export async function initX402Fetch(): Promise<void> {
  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PAYMENT_PRIVATE_KEY environment variable is required");
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  // toClientEvmSigner adapts a LocalAccount to the ClientEvmSigner interface.
  // Only address + signTypedData are needed for the base EIP-3009 flow.
  const signer = toClientEvmSigner(account);
  const evmScheme = new ExactEvmScheme(signer);

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
            return BigInt(r.amount) <= MAX_USDC;
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
