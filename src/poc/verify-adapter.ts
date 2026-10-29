/**
 * circleSolanaSigner アダプタ契約のローカル実行検証(egress 不要・Circle はモック)。
 *   [1] TransactionPartialSigner 実型を満たす(kit の型ガードで実行時確認)
 *   [2] signTransactions が getBase64EncodedWireTransaction で serialize して Circle に渡す((i))
 *   [3] 返りが SignatureDictionary(wallet→64byte)、payer 1件のみ((iii))
 * 実署名・実 API・encoding(ii)・Q3(feePayer≠wallet)は運用者側 PoC。
 * 実行: node dist/poc/verify-adapter.js
 */
import {
  isTransactionPartialSigner,
  assertIsTransactionPartialSigner,
  getBase64EncodedWireTransaction,
  type Transaction,
} from "@solana/kit";
import { circleSolanaSigner, type CircleSignTransactionClient } from "./circle-solana-signer";

const WALLET = "4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf";
const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

// 最小の compiled Transaction を手組み(RPC不要)。messageBytes は serialize が通ればよい。
const fakeTx = {
  messageBytes: new Uint8Array([1, 2, 3, 4, 5]),
  signatures: { [WALLET]: null, [FEE_PAYER]: null },
} as unknown as Transaction;

// モック Circle: rawTransaction を記録し 64byte base64 署名を返す。
let captured: { walletId: string; rawTransaction: string } | null = null;
const fakeSig64 = Buffer.from(new Uint8Array(64).fill(7)).toString("base64");
const mockCircle: CircleSignTransactionClient = {
  async signTransaction(input) {
    captured = input;
    return { data: { signature: fakeSig64 } };
  },
};

async function main(): Promise<void> {
  const signer = circleSolanaSigner(mockCircle, "wallet-123", WALLET);

  if (!isTransactionPartialSigner(signer)) throw new Error("FAIL: not a TransactionPartialSigner");
  assertIsTransactionPartialSigner(signer);
  console.log("[1] OK: circleSolanaSigner は TransactionPartialSigner 実型を満たす");

  type TxArg = Parameters<typeof signer.signTransactions>[0][number];
  const dicts = await signer.signTransactions([fakeTx as unknown as TxArg]);

  const expectedRaw = getBase64EncodedWireTransaction(fakeTx);
  if (!captured) throw new Error("FAIL: Circle が呼ばれていない");
  if (captured.rawTransaction !== expectedRaw) throw new Error("FAIL: rawTransaction が wire serialize 出力と不一致");
  if (captured.walletId !== "wallet-123") throw new Error("FAIL: walletId 不一致");
  console.log("[2] OK: getBase64EncodedWireTransaction(tx) を base64 rawTransaction として Circle に渡した");

  const dict = dicts[0];
  const sig = dict[WALLET as keyof typeof dict] as Uint8Array | undefined;
  if (!sig || sig.length !== 64) throw new Error("FAIL: SignatureDictionary が wallet→64byte でない");
  if (Object.keys(dict).length !== 1) throw new Error("FAIL: dict は payer 1件のみ(feePayer を含めない)");
  console.log("[3] OK: 返りは { [wallet]: 64byte SignatureBytes }(kit が既存 signatures にマージする形)");

  console.log("\nRESULT: アダプタ契約は成立(Q2 の (i)serialize・(iii)差し込み形は実型で確認)。");
  console.log("残ゲート: (ii)Circle署名の実encoding と Q3(feePayer≠wallet署名)は実API必須 → 運用者PoC。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
