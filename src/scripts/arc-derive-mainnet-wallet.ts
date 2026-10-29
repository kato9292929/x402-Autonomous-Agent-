/**
 * One-shot: 既存の Base ウォレットと同じアドレスで、Arc mainnet 上に Circle DCW
 * ウォレットを派生させる。
 *
 * なぜ要るか:
 *   Circle の DCW はウォレットを作成時のチェーンに紐づける。Base のウォレット id で
 *   chain 5042 の EIP-712 を署名すると、チェーンに届く前に Circle が拒む:
 *     signTypedData failed: HTTP 400 {"code":155801, …
 *       "Chain ID is invalid or mismatched with the wallet blockchain"}
 *   (2026-10-20、Exa の Arc leg で実測。アドレスも Arc 上の USDC も正しかった)
 *   なので Arc 用の wallet id が別に要る。
 *
 * なぜ createWallets ではなく deriveWallet か:
 *   createWallets は同じ wallet set でも新しいアドレスを払い出す。実際 wallet set
 *   f9c…de には既に EVM ウォレットが2つあり、0xec…c2c2 と 0xae…fec8 でアドレスが違う。
 *   新アドレスになると、0xae…fec8 に入金済みの Arc USDC をそのウォレットでは使えない。
 *   deriveWallet は「指定したウォレットのアドレスで別の EVM チェーンにウォレットを作る」
 *   API なので、アドレスが同じになることが保証される。
 *   しかも冪等: 既にあればメタデータ更新だけで、何度実行しても増えない。
 *
 * これは Arc **mainnet**・LIVE キー用。Arc Testnet の ERC-8004 用ウォレットは
 * arc-create-wallets.ts(TEST キー)で別に作っている。混ぜないこと。
 *
 * 実行:
 *   npm run build && node dist/scripts/arc-derive-mainnet-wallet.js
 * 必要 env(AA コンテナに既にあるもの):
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET,
 *   CIRCLE_EVM_WALLET_ID, CIRCLE_EVM_WALLET_ADDRESS
 *
 * 出力の CIRCLE_ARC_WALLET_ID を Railway Variables に設定する。
 * 署名・送金は一切しない(ウォレットのメタデータを作るだけ)。
 */
import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { ARC_RPC_DEFAULT, readErc20Usdc } from "../balance-guard";
import { ARC_USDC_ERC20 } from "../payment-guard";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が未設定です`);
  return v;
}

async function main(): Promise<void> {
  const apiKey = required("CIRCLE_API_KEY");
  const entitySecret = required("CIRCLE_ENTITY_SECRET");
  const baseWalletId = required("CIRCLE_EVM_WALLET_ID");
  const baseAddress = required("CIRCLE_EVM_WALLET_ADDRESS");

  // LIVE キーで TEST 環境の値を触らないための確認。逆も同じ(156005 / 156006)。
  if (apiKey.startsWith("TEST_API_KEY")) {
    throw new Error(
      "CIRCLE_API_KEY が TEST キーです。Arc mainnet の派生には LIVE キーが要ります"
    );
  }

  console.log(`派生元: wallet ${baseWalletId} (${baseAddress}, Base)`);
  console.log("派生先: ARC (Arc mainnet)");

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const res = await client.deriveWallet({ id: baseWalletId, blockchain: "ARC" });
  const w = res.data?.wallet;
  if (!w?.id || !w.address) {
    throw new Error(`deriveWallet の応答に id / address がありません: ${JSON.stringify(res.data)}`);
  }

  console.log("\n=== 派生したウォレット ===");
  console.log(`  id          : ${w.id}`);
  console.log(`  address     : ${w.address}`);
  console.log(`  blockchain  : ${w.blockchain}`);
  console.log(`  accountType : ${w.accountType}`);
  console.log(`  walletSetId : ${w.walletSetId}`);
  console.log(`  state       : ${w.state}`);

  // 派生ならアドレスは同じはず。違えば入金済みの USDC はこのウォレットで使えないので、
  // env を設定させずに止める。
  if (w.address.toLowerCase() !== baseAddress.toLowerCase()) {
    throw new Error(
      `アドレスが Base と一致しません (Arc: ${w.address} / Base: ${baseAddress})。` +
        "CIRCLE_ARC_WALLET_ID は設定しないでください"
    );
  }
  console.log("\n✓ アドレスが Base と一致 — 入金済みの Arc USDC をそのまま使えます");

  // 入金済みの残高を、balance-guard と同じ読み方(ERC-20 ビュー・6桁)で確認する。
  try {
    const usdc = await readErc20Usdc(
      w.address,
      process.env.ARC_RPC ?? ARC_RPC_DEFAULT,
      ARC_USDC_ERC20
    );
    console.log(`✓ Arc 上の USDC 残高: ${usdc.toFixed(6)}`);
  } catch (err) {
    console.warn(`(Arc 残高の読み取りに失敗: ${err instanceof Error ? err.message : String(err)})`);
  }

  console.log("\n次を Railway Variables に設定してください:");
  console.log(`  CIRCLE_ARC_WALLET_ID=${w.id}`);
  console.log("  (CIRCLE_ARC_WALLET_ADDRESS は Base と同じなので省略可)");
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
