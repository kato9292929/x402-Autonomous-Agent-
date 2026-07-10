/**
 * Circle DCW → @solana/kit TransactionPartialSigner アダプタ(AA v2 決済層ゲート §4 Q2)。
 *
 * これは v2 の Solana 決済で唯一自前で持つコード(SDK が提供しない差分＝Circle 生署名 API を
 * kit の signer IF に載せる薄いアダプタ)。本番 daily には載せない PoC 資産。
 *
 * ★import は pin 済みの `@solana/kit` 一本から取る(原則2)。@solana/addresses など
 *   サブパッケージは未pinの推移的依存で、この repo では直接解決できない。kit が全て再export。
 *
 * 実型(installed: @solana/kit 6.9.0 / @x402/svm 2.15.0 / @circle-fin/dcw 10.8.0)で確認済み:
 *   TransactionPartialSigner.signTransactions(txs: readonly Transaction[]): Promise<readonly SignatureDictionary[]>
 *   Transaction = { messageBytes, signatures }
 *   getBase64EncodedWireTransaction(tx): Base64EncodedWireTransaction
 *   SignatureDictionary = Readonly<Record<Address, SignatureBytes>>、SignatureBytes = 64byte ed25519
 *   Circle: client.signTransaction({ walletId, rawTransaction }) => { data: { signature } }（SOL は rawTransaction=base64）
 */
import {
  address,
  getBase64EncodedWireTransaction,
  type Address,
  type Transaction,
  type TransactionPartialSigner,
  type SignatureDictionary,
  type SignatureBytes,
} from "@solana/kit";

/**
 * Circle DCW SDK の signTransaction の最小契約(installed v10.8.0 型より)。
 * rawTransaction: Solana は base64。返り signature の encoding は PoC(ii) で実確認する。
 */
export interface CircleSignTransactionClient {
  signTransaction(input: {
    walletId: string;
    rawTransaction: string;
  }): Promise<{ data?: { signature?: string } }>;
}

/** base58 decode を差し替え可能に(PoC では @scure/base 等を注入)。 */
export type Base58Decode = (s: string) => Uint8Array;

/**
 * Circle が返す signature を 64byte ed25519 に。encoding(base64/base58)は PoC(ii) で確定するまで
 * 両対応: まず base64 を試し 64byte なら採用、違えば base58 decoder(注入時)で 64byte を得る。
 */
export function decodeSignatureTo64Bytes(
  sig: string,
  base58Decode?: Base58Decode
): SignatureBytes {
  const asB64 = Buffer.from(sig, "base64");
  if (asB64.length === 64) return new Uint8Array(asB64) as SignatureBytes;
  if (base58Decode) {
    const b58 = base58Decode(sig);
    if (b58.length === 64) return (b58 instanceof Uint8Array ? b58 : new Uint8Array(b58)) as SignatureBytes;
    throw new Error(`Circle signature base58-decoded to ${b58.length} bytes (expected 64)`);
  }
  throw new Error(
    "Circle signature is not 64-byte base64; confirm encoding (PoC ii) and pass a base58Decode"
  );
}

/**
 * Circle DCW を payer 署名器として使う TransactionPartialSigner を返す。
 * @x402/svm の ExactSvmScheme(this.signer) に渡すと、partiallySignTransactionMessageWithSigners が
 * これを呼び、compiled tx を Circle に送って署名を得て tx にマージする。
 */
export function circleSolanaSigner(
  client: CircleSignTransactionClient,
  walletId: string,
  walletSolAddress: string,
  base58Decode?: Base58Decode
): TransactionPartialSigner {
  const addr = address(walletSolAddress);
  return {
    address: addr,
    async signTransactions(
      transactions: readonly Transaction[]
    ): Promise<readonly SignatureDictionary[]> {
      return Promise.all(
        transactions.map(async (tx) => {
          // (i) kit が渡す compiled Transaction を Circle が食う base64 wire に無損失変換
          const rawTransaction = getBase64EncodedWireTransaction(tx);
          // (Q1) Circle に外部tx署名を要求(v10.8.0 型で存在確認済み・SOL 対応)
          const res = await client.signTransaction({ walletId, rawTransaction });
          const sig = res.data?.signature;
          if (!sig) throw new Error("Circle signTransaction returned no signature");
          // (ii) encoding 確認込みで 64byte に
          const sigBytes = decodeSignatureTo64Bytes(sig, base58Decode);
          // (iii) payer(=このwallet)の署名として返す → kit が既存 signatures にマージ
          const dict: Record<Address, SignatureBytes> = { [addr]: sigBytes };
          return dict as SignatureDictionary;
        })
      );
    },
  };
}
