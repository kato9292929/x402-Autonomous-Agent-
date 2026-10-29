/**
 * Circle DCW as the Solana payment signer, for the production payment path.
 *
 * The adapter itself lives in poc/circle-solana-signer.ts, where it was proven
 * on-chain (0.01 USDC from the Circle Solana wallet, settled). This module is
 * the production factory around it: it builds the Circle client from env and
 * hands back a signer the SVM scheme can use, mirroring how
 * circle/evm-signer.ts already backs the Base leg.
 *
 * Moving to this signer takes the raw Solana private key out of the deployment:
 * the key stays in Circle, and the agent only holds a wallet id.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { base58 } from "@scure/base";
import type { TransactionPartialSigner } from "@solana/kit";
import {
  circleSolanaSigner,
  type CircleSignTransactionClient,
} from "../poc/circle-solana-signer";

export interface CircleSolanaSignerInfo {
  signer: TransactionPartialSigner;
  address: string;
  walletId: string;
}

/**
 * Build the Circle-backed Solana signer from env, or return undefined when it
 * is not configured. Returning undefined (rather than throwing) lets the caller
 * fall back to SOLANA_PRIVATE_KEY, so enabling this is a reversible switch.
 */
export function getCircleSolanaSignerFromEnv(): CircleSolanaSignerInfo | undefined {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletId = process.env.CIRCLE_SOLANA_WALLET_ID;
  const walletAddress = process.env.CIRCLE_SOLANA_WALLET_ADDRESS;

  if (!apiKey || !entitySecret || !walletId || !walletAddress) return undefined;

  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const client: CircleSignTransactionClient = {
    async signTransaction(input) {
      const r = await circle.signTransaction({
        walletId: input.walletId,
        rawTransaction: input.rawTransaction,
      });
      return { data: { signature: r.data?.signature } };
    },
  };

  return {
    // Circle returns the signature base58-encoded for Solana; the adapter tries
    // base64 first and falls back to this decoder.
    signer: circleSolanaSigner(client, walletId, walletAddress, (s) => base58.decode(s)),
    address: walletAddress,
    walletId,
  };
}

/** Which Solana signer the agent should use, given the current env. */
export function resolveSolanaBackend(): "circle" | "privatekey" | "none" {
  const circleReady =
    Boolean(process.env.CIRCLE_API_KEY) &&
    Boolean(process.env.CIRCLE_ENTITY_SECRET) &&
    Boolean(process.env.CIRCLE_SOLANA_WALLET_ID) &&
    Boolean(process.env.CIRCLE_SOLANA_WALLET_ADDRESS);

  // SOLANA_SIGNER_BACKEND lets the switch be made (and reverted) without a
  // deploy. Defaults to the local key so enabling Circle is deliberate.
  const requested = process.env.SOLANA_SIGNER_BACKEND ?? "privatekey";

  if (requested === "circle") return circleReady ? "circle" : "none";
  return process.env.SOLANA_PRIVATE_KEY ? "privatekey" : "none";
}
