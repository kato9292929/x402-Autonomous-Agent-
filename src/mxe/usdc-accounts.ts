/**
 * USDC token accounts (ATAs) for the MXE agents, created by the AA's own
 * Solana wallet.
 *
 * A Circle transfer to an address that has never held USDC must also create
 * its token account, and Circle refuses that for this account:
 * "PAYMASTER_SOL_ATA_CREATION_NOT_ALLOWED" (11/3). So the accounts are created
 * here first, in one transaction paid in SOL by the AA wallet and signed
 * through Circle's raw-transaction signing (the same path the x402 payments
 * use). With the account in place, Circle only has to move the USDC.
 *
 * Built by hand rather than with @solana/spl-token: it is one instruction
 * (CreateIdempotent), and the address derivation is pinned by a test.
 */
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { SOLANA_USDC_MINT } from "../balance-guard";
import type { MxeWallet } from "./chain";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey(SOLANA_USDC_MINT);

export function usdcAta(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), USDC.toBuffer()], ATA_PROGRAM_ID)[0];
}

/** Associated Token Account program, CreateIdempotent (instruction 1): no-op if it exists. */
export function createUsdcAtaIx(payer: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: usdcAta(owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** Create the USDC accounts the owners lack, paid by `payer`. Returns which were created. */
export async function ensureUsdcAccounts(
  connection: Connection,
  payer: MxeWallet,
  owners: string[]
): Promise<{ created: string[]; tx?: string }> {
  const missing: PublicKey[] = [];
  for (const o of owners) {
    const owner = new PublicKey(o);
    if (!(await connection.getAccountInfo(usdcAta(owner), "confirmed"))) missing.push(owner);
  }
  if (missing.length === 0) return { created: [] };

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
  for (const owner of missing) tx.add(createUsdcAtaIx(payer.publicKey, owner));
  const signed = await payer.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`creating USDC accounts failed: ${JSON.stringify(res.value.err)} (tx ${sig})`);
  return { created: missing.map((m) => m.toBase58()), tx: sig };
}
