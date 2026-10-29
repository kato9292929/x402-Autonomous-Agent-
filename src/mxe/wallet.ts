/**
 * The devnet fee payer for MXE computations: a Circle DCW wallet on SOL-DEVNET
 * (TEST environment), created by `npm run mxe:setup`.
 *
 * It is a separate signer on purpose — the mainnet payment wallets never sign
 * a devnet transaction, and this one never holds anything of value.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { base58 } from "@scure/base";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { decodeSignatureTo64Bytes } from "../poc/circle-solana-signer";
import type { MxeWallet } from "./chain";

export interface CircleRawSigner {
  signTransaction(input: { walletId: string; rawTransaction: string }): Promise<{ data?: { signature?: string } }>;
}

/** Wrap a Circle signer as the wallet Anchor's `.rpc()` signs with. */
export function circleMxeWallet(client: CircleRawSigner, walletId: string, address: string): MxeWallet {
  const publicKey = new PublicKey(address);
  const sign = async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    const raw =
      tx instanceof VersionedTransaction
        ? Buffer.from(tx.serialize())
        : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const res = await client.signTransaction({ walletId, rawTransaction: raw.toString("base64") });
    const sig = res.data?.signature;
    if (!sig) throw new Error("Circle signTransaction returned no signature");
    const bytes = decodeSignatureTo64Bytes(sig, (s) => base58.decode(s));
    if (tx instanceof VersionedTransaction) tx.addSignature(publicKey, bytes);
    else tx.addSignature(publicKey, Buffer.from(bytes));
    return tx;
  };
  return {
    publicKey,
    signTransaction: sign,
    signAllTransactions: async (txs) => {
      const out = [];
      for (const t of txs) out.push(await sign(t));
      return out;
    },
  };
}

/** From env, or undefined with the names that are missing. */
export function devnetQueuerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { wallet: MxeWallet; address: string } | { missing: string[] } {
  const need = [
    "CIRCLE_API_KEY_TEST",
    "CIRCLE_ENTITY_SECRET_TEST",
    "CIRCLE_MXE_DEVNET_QUEUER_WALLET_ID",
    "CIRCLE_MXE_DEVNET_QUEUER_WALLET_ADDRESS",
  ];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) return { missing };
  const circle = initiateDeveloperControlledWalletsClient({
    apiKey: env.CIRCLE_API_KEY_TEST!,
    entitySecret: env.CIRCLE_ENTITY_SECRET_TEST!,
  });
  const client: CircleRawSigner = {
    async signTransaction(input) {
      const r = await circle.signTransaction(input);
      return { data: { signature: r.data?.signature } };
    },
  };
  const address = env.CIRCLE_MXE_DEVNET_QUEUER_WALLET_ADDRESS!;
  return { wallet: circleMxeWallet(client, env.CIRCLE_MXE_DEVNET_QUEUER_WALLET_ID!, address), address };
}
