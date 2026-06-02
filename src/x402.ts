import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createCircleEvmSigner } from "./circle/evm-signer";
import { isCircleConfigured } from "./circle/client";
import { SpendingControls } from "./circle/spending-controls";

let _fetchWithPayment:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

let _spending: SpendingControls | null = null;

/**
 * The active spending controls. Available after {@link initX402Fetch}.
 * Callers record confirmed payments via `getSpendingControls().record(usd)`.
 */
export function getSpendingControls(): SpendingControls {
  if (!_spending) {
    throw new Error("Spending controls not initialized. Call initX402Fetch() first.");
  }
  return _spending;
}

/**
 * Build the EVM signer for x402 payments.
 *
 * Selection is an explicit, production-safe opt-in via `SIGNER_BACKEND`:
 *   - unset / "privatekey" (DEFAULT) → legacy local `PAYMENT_PRIVATE_KEY` signer.
 *     Existing deployments are unchanged until you flip the flag — adding Circle
 *     env vars alone does NOT switch the signer.
 *   - "circle" → Circle Developer-Controlled Wallets. The key lives in Circle's
 *     HSM and signing happens via the `signTypedData` API.
 */
function buildEvmSigner(): ClientEvmSigner {
  const backend = (process.env.SIGNER_BACKEND ?? "privatekey").toLowerCase();

  if (backend === "circle") {
    if (!isCircleConfigured()) {
      throw new Error(
        "SIGNER_BACKEND=circle but Circle is not configured. Set CIRCLE_API_KEY " +
          "and CIRCLE_ENTITY_SECRET (and run circle:setup for the wallet)."
      );
    }
    console.log("[x402] Signer backend: Circle Developer-Controlled Wallets");
    return createCircleEvmSigner();
  }

  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "No signer available: set PAYMENT_PRIVATE_KEY, or set SIGNER_BACKEND=circle " +
        "with Circle env vars (CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, " +
        "CIRCLE_EVM_WALLET_ID, CIRCLE_EVM_WALLET_ADDRESS)."
    );
  }
  console.warn(
    "[x402] Signer backend: legacy PAYMENT_PRIVATE_KEY (local key). " +
      "Set SIGNER_BACKEND=circle to use Circle Wallets."
  );
  return toClientEvmSigner(privateKeyToAccount(privateKey as `0x${string}`));
}

export async function initX402Fetch(): Promise<void> {
  const signer = buildEvmSigner();
  const evmScheme = new ExactEvmScheme(signer);

  _spending = SpendingControls.fromEnv();
  console.log(`[x402] Spending controls — ${_spending.summary()}`);

  const client = new x402Client()
    // v2 servers: CAIP-2 network identifiers (mainnet + Base Sepolia testnet)
    .register("eip155:8453", evmScheme) // Base mainnet
    .register("eip155:84532", evmScheme) // Base Sepolia testnet
    // v1 servers: legacy network names — keeps old endpoints working
    .registerV1("base", evmScheme)
    .registerV1("base-sepolia", evmScheme)
    // Enforce per-tx / daily / allowlist spending controls before signing
    .registerPolicy(_spending.policy);

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
