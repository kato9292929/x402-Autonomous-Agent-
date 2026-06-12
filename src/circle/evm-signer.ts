/**
 * Circle Developer-Controlled Wallets — EVM signer for @x402/fetch v2.
 *
 * Implements ClientEvmSigner using Circle's sign/typedData API so that
 * Base x402 payments can be authorized by a Circle DCW wallet instead of
 * a local private key (SIGNER_BACKEND=circle).
 *
 * Circle API endpoint used:
 *   POST https://api.circle.com/v1/w3s/developer/wallets/{walletId}/sign/typedData
 *
 * If this endpoint returns an error, verify:
 *   1. CIRCLE_EVM_WALLET_ID is correct and the wallet is active
 *   2. The wallet has sufficient USDC on Base mainnet
 *   3. Circle DCW v1 typed-data signing is enabled for your entity
 *
 * Reference: https://developers.circle.com/w3s/reference/developersigntyped
 */
import type { ClientEvmSigner } from "@x402/evm";
import { CIRCLE_API, buildEntitySecretCiphertext, getRequiredApiKey } from "./client";

export function createCircleEvmSigner(
  walletId: string,
  walletAddress: `0x${string}`
): ClientEvmSigner {
  return {
    address: walletAddress,

    async signTypedData({ domain, types, primaryType, message }) {
      const apiKey = getRequiredApiKey();
      const entitySecretCiphertext = await buildEntitySecretCiphertext(apiKey);

      const res = await fetch(
        `${CIRCLE_API}/developer/wallets/${walletId}/sign/typedData`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            data: JSON.stringify({ domain, types, primaryType, message }),
            entitySecretCiphertext,
          }),
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        throw new Error(
          `[CIRCLE:EVM] signTypedData failed: HTTP ${res.status} — ${body.slice(0, 300)}`
        );
      }

      const json = (await res.json()) as { data: { signature: string } };
      const signature = json.data?.signature;
      if (!signature) {
        throw new Error("[CIRCLE:EVM] signTypedData: no signature in response");
      }

      return signature as `0x${string}`;
    },
  };
}

export function getCircleEvmSignerFromEnv(): ClientEvmSigner {
  const walletId = process.env.CIRCLE_EVM_WALLET_ID;
  const walletAddress = process.env.CIRCLE_EVM_WALLET_ADDRESS;
  if (!walletId || !walletAddress) {
    throw new Error(
      "CIRCLE_EVM_WALLET_ID and CIRCLE_EVM_WALLET_ADDRESS are required when SIGNER_BACKEND=circle"
    );
  }
  return createCircleEvmSigner(walletId, walletAddress as `0x${string}`);
}
