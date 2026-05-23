import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  throw new Error("PRIVATE_KEY environment variable is required");
}

const account = privateKeyToAccount(privateKey as `0x${string}`);

// Allow up to $3.00 USDC per request (covers weekly reports at $3.00)
export const fetchWithPayment = wrapFetchWithPayment(
  fetch,
  account as unknown as import("x402-fetch").Signer,
  BigInt(3_000_000)
);
