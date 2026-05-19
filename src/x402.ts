import { createSigner, wrapFetchWithPayment } from "x402-fetch";

let _fetchWithPayment:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

export async function initX402Fetch(): Promise<void> {
  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PAYMENT_PRIVATE_KEY is required for x402 payments");
  }

  const signer = await createSigner("base", privateKey);
  // Allow up to $2.00 USDC per request (covers Alpha Memo's $1.00 cost)
  const maxValue = BigInt(2_000_000); // 2 USDC in 6-decimal units
  _fetchWithPayment = wrapFetchWithPayment(fetch, signer, maxValue);
}

export async function fetchWithX402(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (!_fetchWithPayment) {
    throw new Error("x402 fetch not initialized. Call initX402Fetch() first.");
  }
  return _fetchWithPayment(url, options);
}
