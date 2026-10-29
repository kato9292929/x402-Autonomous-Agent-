/**
 * One-shot: Arcium MXE 統合(devnet 段階)の準備を1回で済ませる。
 *
 * 指示書の「本人の操作が要るものは1回にまとめる」に合わせ、Circle 側と鍵の準備を
 * このスクリプト1本に寄せた。何度実行しても増えない(refId で既存を探してから作る)。
 *
 * 作るもの:
 *   1. Circle TEST 環境の SOL-DEVNET ウォレット1つ — devnet で MXE の計算を投入する署名者。
 *      Circle のウォレットは作成時のチェーンに紐づく(Arc で 155801 として実測済み)ので、
 *      mainnet の 7PVTo… で devnet の tx を署名できるとは仮定しない。
 *   2. Circle LIVE の Solana ウォレット4つ — AA 内に置く内部エージェント。
 *        売り手 A・B(機能1・2・4):x402 の受取先。--fund で $0.01 を入れて USDC の
 *          受取口座(ATA)を作る。口座のない宛先への x402 送金は失敗する
 *        買い手 A・B(機能1・2・4):支払う側。--fund で少額を入れる
 *      いずれも「内部取引」の相手方で、外部の需要の証拠にはしない。
 *   3. (--deploy-key)devnet のプログラム管理鍵(upgrade authority)。
 *      `arcium deploy --keypair-path` はファイルの鍵を要求し、Circle DCW は使えない。
 *      実行時の署名(計算の投入・x402 支払い)はすべて Circle DCW のまま。
 *
 * 通常は実行不要: MXE ジョブが起動時に、足りないウォレットを作り、MXE_FUND_AGENTS=true なら
 * 入金もする(ensureAgents)。手で回すとき(手元のターミナル):
 *   npm run build && npm run mxe:setup                 # ウォレットの作成だけ
 *   npm run mxe:setup -- --deploy-key                  # + devnet 管理鍵を出力
 *   npm run mxe:setup -- --fund                        # + 買い手A・Bへ各 $0.10、売り手A・Bへ各 $0.01 送る
 *
 * 必要 env(既存):
 *   LIVE: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET
 *   TEST: CIRCLE_API_KEY_TEST, CIRCLE_ENTITY_SECRET_TEST
 *   任意: CIRCLE_SOLANA_WALLET_ID(無ければ AA の Solana ウォレットの公開アドレスで探す)、
 *         CIRCLE_WALLET_SET_ID_TEST(無ければ devnet 署名者の set か、名前 aa-mxe-devnet の set を探し、
 *         それも無ければ作る)
 *   GitHub Actions の mxe-setup ワークフローからも回せる(手元に .env を作らなくてよい)
 *
 * 資金が動くのは --fund を付けたときだけ。それ以外は作成と読み取りのみ。
 */
import "dotenv/config";
import * as crypto from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { base58 } from "@scure/base";
import { Keypair } from "@solana/web3.js";
import { SOLANA_USDC_MINT } from "../balance-guard";
import { DEVNET_QUEUER, LIVE_AGENTS, findWalletByRef, type AgentSpec } from "../mxe/wallets";

type Client = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

/** AA's Circle Solana wallet (public address; README "Circle DCW 7PV…L6tY"). */
export const AA_SOLANA_WALLET = "7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が未設定です`);
  return v;
}

/**
 * A UUID derived from a fixed string, so a retried transfer reuses its
 * idempotency key instead of sending twice. Circle requires UUID format.
 */
export function stableUuid(seed: string): string {
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Find a wallet by refId in a set, or create it. Never creates a second one. */
async function ensureWallet(
  client: Client,
  walletSetId: string,
  blockchain: "SOL" | "SOL-DEVNET",
  spec: AgentSpec
): Promise<{ id: string; address: string; created: boolean }> {
  // Any set: the job finds wallets by refId alone, so there must be one per refId.
  const existing = await findWalletByRef(client, spec.refId, blockchain);
  if (existing) return { id: existing.id, address: existing.address, created: false };
  const res = await client.createWallets({
    walletSetId,
    blockchains: [blockchain],
    count: 1,
    accountType: "EOA",
    metadata: [{ name: spec.refId, refId: spec.refId }],
  });
  const w = res.data?.wallets?.[0];
  if (!w?.id || !w.address) {
    throw new Error(`${spec.refId} の作成に失敗: ${JSON.stringify(res.data)}`);
  }
  return { id: w.id, address: w.address, created: true };
}

async function usdcBalance(client: Client, walletId: string): Promise<number> {
  const res = await client.getWalletTokenBalance({ id: walletId });
  const row = (res.data?.tokenBalances ?? []).find(
    (b) => b.token?.tokenAddress === SOLANA_USDC_MINT
  );
  return row ? Number(row.amount) : 0;
}

/**
 * A Solana CLI keypair file (64-byte JSON array: seed ‖ public key), which is
 * what `arcium deploy --keypair-path` reads. Generated with node:crypto because
 * WebCrypto will not export an Ed25519 private key in raw form.
 */
export function generateDeployKey(): { json: string; address: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  if (d.length !== 32 || x.length !== 32) throw new Error("Ed25519 鍵の長さが不正");
  return { json: JSON.stringify([...d, ...x]), address: base58.encode(x) };
}

/**
 * The aa_mxe program id the devnet deploy job will use for this deploy key.
 * Same derivation as mxe/scripts/derive-program-keypair.js (kept in step by a
 * test), so MXE_PROGRAM_ID can go into Railway together with everything else
 * instead of waiting for the first deploy.
 */
export function programIdFor(deployKeyJson: string): string {
  const deploy = JSON.parse(deployKeyJson) as number[];
  if (!Array.isArray(deploy) || deploy.length !== 64) throw new Error("deploy key must be a 64-byte JSON array");
  const seed = crypto.createHash("sha256").update("aa-mxe/program-id/v1").update(Buffer.from(deploy.slice(0, 32))).digest();
  return Keypair.fromSeed(seed).publicKey.toBase58();
}

async function setupLive(fund: boolean): Promise<string[]> {
  const apiKey = required("CIRCLE_API_KEY");
  if (apiKey.startsWith("TEST_API_KEY")) {
    throw new Error("CIRCLE_API_KEY が TEST キーです。内部エージェントは mainnet(LIVE)で作ります");
  }
  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret: required("CIRCLE_ENTITY_SECRET"),
  });

  // 既存の Solana ウォレット(7PVTo…)と同じ wallet set に置く。set ID を env に
  // 持たせなくて済むよう、既知のウォレットから引く。
  // By id when given, else by its (public) address, so CI needs no wallet id.
  let payerId = process.env.CIRCLE_SOLANA_WALLET_ID;
  if (!payerId) {
    const addr = process.env.CIRCLE_SOLANA_WALLET_ADDRESS ?? AA_SOLANA_WALLET;
    payerId = (await client.listWallets({ address: addr, blockchain: "SOL" })).data?.wallets?.[0]?.id;
    if (!payerId) throw new Error(`Circle に ${addr} の Solana ウォレットが見つかりません`);
  }
  const payer = (await client.getWallet({ id: payerId })).data?.wallet;
  if (!payer?.walletSetId || !payer.address) {
    throw new Error(`AA の Solana ウォレット(${payerId})の wallet set を取得できません`);
  }
  console.log(`\n[LIVE] wallet set ${payer.walletSetId}(${payer.address} と同じ set)`);

  const lines: string[] = [];
  for (const spec of LIVE_AGENTS) {
    const w = await ensureWallet(client, payer.walletSetId, "SOL", spec);
    console.log(`  ${w.created ? "作成" : "既存"}  ${spec.role}: ${w.address}`);
    lines.push(`${spec.env}_WALLET_ID=${w.id}`, `${spec.env}_WALLET_ADDRESS=${w.address}`);

    if (fund && spec.fund) {
      const have = await usdcBalance(client, w.id);
      if (have >= Number(spec.fund)) {
        console.log(`        USDC ${have} 保有済み — 送らない`);
        continue;
      }
      const tx = await client.createTransaction({
        walletId: payerId,
        tokenAddress: SOLANA_USDC_MINT,
        amount: [spec.fund],
        destinationAddress: w.address,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: stableUuid(`aa-mxe-fund:${spec.refId}:v1`),
        refId: `aa-mxe-fund-${spec.refId}`,
      });
      console.log(`        → $${spec.fund} USDC を送金(tx ${tx.data?.id}, ${tx.data?.state})`);
    }
  }
  return lines;
}

async function setupDevnet(): Promise<string[]> {
  const apiKey = required("CIRCLE_API_KEY_TEST");
  if (!apiKey.startsWith("TEST_API_KEY")) {
    throw new Error("CIRCLE_API_KEY_TEST が LIVE キーです。devnet は TEST 環境で作ります");
  }
  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret: required("CIRCLE_ENTITY_SECRET_TEST"),
  });

  const lines: string[] = [];
  let walletSetId =
    process.env.CIRCLE_WALLET_SET_ID_TEST ??
    (await findWalletByRef(client, DEVNET_QUEUER.refId, "SOL-DEVNET"))?.walletSetId ??
    (await client.listWalletSets({})).data?.walletSets?.find((w) => (w as { name?: string }).name === "aa-mxe-devnet")?.id;
  if (!walletSetId) {
    const res = await client.createWalletSet({ name: "aa-mxe-devnet" });
    walletSetId = res.data?.walletSet?.id;
    if (!walletSetId) throw new Error(`TEST の wallet set 作成に失敗: ${JSON.stringify(res.data)}`);
    console.log(`\n[TEST] wallet set を作成: ${walletSetId}`);
    // 次回からは名前(または devnet 署名者の所属)で見つかるので、ID を控える必要はない。
  } else {
    console.log(`\n[TEST] wallet set ${walletSetId}`);
  }

  const w = await ensureWallet(client, walletSetId, "SOL-DEVNET", DEVNET_QUEUER);
  console.log(`  ${w.created ? "作成" : "既存"}  ${DEVNET_QUEUER.role}: ${w.address}`);
  lines.push(`${DEVNET_QUEUER.env}_WALLET_ID=${w.id}`, `${DEVNET_QUEUER.env}_WALLET_ADDRESS=${w.address}`);

  // 計算手数料とコールバック分の devnet SOL。Circle の faucet で足りなければ CI で airdrop する。
  try {
    await client.requestTestnetTokens({ address: w.address, blockchain: "SOL-DEVNET", native: true });
    console.log("        devnet SOL を Circle faucet に要求しました");
  } catch (err) {
    console.warn(
      `        Circle faucet が拒否(${err instanceof Error ? err.message : String(err)})— CI の airdrop に回します`
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const fund = process.argv.includes("--fund");
  const wantKey = process.argv.includes("--deploy-key");

  if (fund) {
    console.log("--fund: 買い手 A・B に各 $0.10、売り手 A・B に各 $0.01 USDC を CIRCLE_SOLANA_WALLET_ID から送ります(未保有の場合のみ。売り手分は x402 の受取口座を作るため)");
  }

  const variables = [...(await setupLive(fund)), ...(await setupDevnet())];
  const key = wantKey ? generateDeployKey() : undefined;
  if (key) variables.push(`MXE_PROGRAM_ID=${programIdFor(key.json)}`);

  // Not to be registered: the job finds the wallets by refId and carries the
  // devnet program id in src/mxe/flags.ts. Shown so the run can be checked.
  console.log("\n==== 参考(登録は不要。ジョブが refId で見つける)====");
  for (const l of variables) console.log(l);

  if (key) {
    console.log("\n==== GitHub の Actions secret に登録(devnet デプロイ用。Railway には入れない)====");
    console.log("名前: ARCIUM_DEVNET_DEPLOY_KEY");
    console.log(`値  : ${key.json}`);
    console.log(`(この鍵のアドレス: ${key.address} — devnet の upgrade authority。デプロイ用の devnet SOL はここへ)`);
    console.log("※ 実行するたびに新しい鍵になります。登録は1回だけ。devnet 専用で、mainnet には使わない");
  }
}

/**
 * Create whatever agent wallets are missing (by refId) and, with `fund`, top
 * the LIVE ones up to their amount. Called by the MXE job itself, so a
 * deployment needs no separate setup step. Idempotent: nothing is created
 * twice, and a funding transfer reuses a fixed idempotency key.
 */
export async function ensureAgents(opts: { live: boolean; devnet: boolean; fund: boolean }): Promise<void> {
  if (opts.live) await setupLive(opts.fund);
  if (opts.devnet) await setupDevnet();
}

// Run only when invoked as a script, so the tests can import the helpers.
if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
