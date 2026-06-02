import { getCircleClient } from "./client";

/**
 * Circle-backed Solana signer.
 *
 * NOTE: The AA currently calls only Base (EVM) x402 endpoints — every entry in
 * `config.ts` is `chain: "base"`, and no Solana x402 scheme is registered. This
 * module is the Circle building block for when a Solana endpoint is added: it
 * replaces the old `solana-web3.js` keypair signing with Circle's
 * `signTransaction` API (SOL-DEVNET on testnet, SOL on mainnet), so the key
 * never leaves Circle's HSM.
 *
 * An x402 Solana ("exact-svm") scheme hands the client a serialized transaction
 * to sign; `signSolanaTransaction` below returns Circle's signature for it.
 */

export interface CircleSolanaSignerConfig {
  /** Circle wallet id (UUID). Defaults to CIRCLE_SOLANA_WALLET_ID. */
  walletId?: string;
  /** Solana address (base58). Defaults to CIRCLE_SOLANA_WALLET_ADDRESS. */
  address?: string;
}

export interface CircleSolanaSigner {
  readonly address: string;
  /** Sign a base64-encoded raw Solana transaction; returns the signature. */
  signTransaction(rawTransactionBase64: string): Promise<string>;
}

export function createCircleSolanaSigner(
  config: CircleSolanaSignerConfig = {}
): CircleSolanaSigner {
  const walletId = config.walletId ?? process.env.CIRCLE_SOLANA_WALLET_ID;
  const address = config.address ?? process.env.CIRCLE_SOLANA_WALLET_ADDRESS;

  if (!walletId) {
    throw new Error(
      "CIRCLE_SOLANA_WALLET_ID is required to build the Circle Solana signer. " +
        "Run `npm run circle:setup` to create a wallet."
    );
  }
  if (!address) {
    throw new Error(
      "CIRCLE_SOLANA_WALLET_ADDRESS is required to build the Circle Solana signer. " +
        "Run `npm run circle:setup` to create a wallet."
    );
  }

  const client = getCircleClient();

  return {
    address,
    async signTransaction(rawTransactionBase64: string): Promise<string> {
      const res = await client.signTransaction({
        walletId,
        rawTransaction: rawTransactionBase64,
      });
      const signature = res.data?.signature;
      if (!signature) {
        throw new Error(
          "Circle signTransaction returned no signature (response: " +
            JSON.stringify(res.data) +
            ")"
        );
      }
      return signature;
    },
  };
}
