import { createSigner, wrapFetchWithPayment } from "x402-fetch";

let _fetchWithPayment:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

export async function initX402Fetch(): Promise<void> {
  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PAYMENT_PRIVATE_KEY environment variable is required");
  }

  // createSigner returns a proper SignerWallet (viem Client with chain context).
  // Using privateKeyToAccount (LocalAccount) causes network=undefined in
  // wrapFetchWithPayment, which loses Base chain context and leads to
  // "unexpected_error" from the facilitator.
  const signer = await createSigner("base", privateKey);
  _fetchWithPayment = wrapFetchWithPayment(
    fetch,
    signer,
    BigInt(3_000_000) // up to $3.00 USDC per request
  );
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
