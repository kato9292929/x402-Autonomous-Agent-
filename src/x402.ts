/**
 * x402 fetch initialization for Base (EVM) and Solana payments.
 *
 * EVM signing backend (SIGNER_BACKEND):
 *   "circle"     — Circle Developer-Controlled Wallet (CIRCLE_EVM_WALLET_ID + CIRCLE_EVM_WALLET_ADDRESS)
 *   "privatekey" — Local EOA private key (PAYMENT_PRIVATE_KEY)  ← default
 *
 * Solana signing backend (SOLANA_SIGNER_BACKEND):
 *   "circle"     — Circle Developer-Controlled Wallet (CIRCLE_SOLANA_WALLET_ID + CIRCLE_SOLANA_WALLET_ADDRESS)
 *   "privatekey" — Local keypair from SOLANA_PRIVATE_KEY (base58 64-byte)  ← default
 * If neither is configured, Solana endpoints are skipped.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { registerExactSvmScheme, ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes, type TransactionPartialSigner } from "@solana/kit";
import { base58 } from "@scure/base";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "@x402/core/types";
import { getCircleEvmSignerFromEnv, createCircleEvmSigner } from "./circle/evm-signer";
import { getCircleSolanaSignerFromEnv, resolveSolanaBackend } from "./circle/solana-signer";
import { DEFAULT_MAX_BASE_MICRO_USDC } from "./circle/spending-controls";
import { TESTNET_NETWORK } from "./payment-guard";

let _fetchWithPayment:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

/**
 * Address of the wallet that actually signs Solana payments, captured when the
 * signer is built. The balance check uses this rather than SOLANA_WALLET_ADDRESS
 * so it can never end up reporting on a different wallet than the one paying.
 */
let _solanaPayerAddress: string | undefined;

export function getSolanaPayerAddress(): string | undefined {
  return _solanaPayerAddress;
}

export interface EvmSchemeInfo {
  scheme: ExactEvmScheme;
  address: string;
  backend: "circle" | "privatekey";
}

/**
 * SIGNER_BACKEND(circle / privatekey) に従って EVM 署名スキームを構築し、選ばれた
 * backend と実 signer.address も返す。本番(initX402Fetch)と test-payment で同一の署名
 * バックエンド選択を共有し、署名ウォレットの取り違えを防ぐ。
 */
export function buildEvmSchemeWithInfo(): EvmSchemeInfo {
  const backend = process.env.SIGNER_BACKEND ?? "privatekey";

  if (backend === "circle") {
    console.log("[X402] Using Circle DCW signer for Base (SIGNER_BACKEND=circle)");
    const signer = getCircleEvmSignerFromEnv();
    console.log(`[X402] Circle EVM wallet: ${signer.address}`);
    return { scheme: new ExactEvmScheme(signer), address: signer.address, backend: "circle" };
  }

  const privateKey = process.env.PAYMENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "PAYMENT_PRIVATE_KEY is required when SIGNER_BACKEND=privatekey (default). " +
      "Set SIGNER_BACKEND=circle to use Circle DCW instead."
    );
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`[X402] Using private key signer for Base: ${account.address}`);
  return {
    scheme: new ExactEvmScheme(toClientEvmSigner(account)),
    address: account.address,
    backend: "privatekey",
  };
}

function buildEvmScheme(): ExactEvmScheme {
  return buildEvmSchemeWithInfo().scheme;
}

/**
 * per-call の micro-USDC 上限 policy 判定。
 *
 * v2 leg は金額を `amount`、v1 leg(Solana が返す形)は `maxAmountRequired` に持つ。旧実装は
 * `r.amount` だけを読み、v1 leg で BigInt(undefined) が throw → その leg が全弾され、
 * @x402/core の selectPaymentRequirements 段階3で
 * "All payment requirements were filtered out by policies for x402 version: 1" になっていた。
 * 存在する方のフィールドを読むことで v1 leg を生かす。上限セマンティクスは不変
 * (USDC は Base/Solana とも 6 桁なので同じ micro-USDC 閾値で正しく効く)。
 */
export function withinMicroUsdcCap(
  r: { amount?: string; maxAmountRequired?: string },
  maxMicroUsdc: bigint
): boolean {
  try {
    const raw = r.amount ?? r.maxAmountRequired;
    if (raw === undefined || raw === null) return false;
    return BigInt(raw) <= maxMicroUsdc;
  } catch {
    return false;
  }
}

export async function initX402Fetch(): Promise<void> {
  const evmScheme = buildEvmScheme();
  const maxUsdc = DEFAULT_MAX_BASE_MICRO_USDC;

  const client = new x402Client()
    .register("eip155:8453", evmScheme)
    .registerV1("base", evmScheme)
    .registerPolicy((_version: number, reqs: PaymentRequirements[]) =>
      reqs.filter((r) => withinMicroUsdcCap(r, maxUsdc))
    );

  // Base Sepolia leg for the buyer-side demo. Off unless explicitly enabled, so
  // the daily run never gains a testnet leg by accident. Its wallet lives under
  // the Circle TEST credentials — a LIVE key is rejected on testnet chains.
  if (process.env.X402_TESTNET_ENABLED === "true") {
    const testnetWalletId = process.env.CIRCLE_BASE_SEPOLIA_WALLET_ID;
    const testnetAddress = process.env.CIRCLE_BASE_SEPOLIA_WALLET_ADDRESS;
    if (!testnetWalletId || !testnetAddress) {
      throw new Error(
        "X402_TESTNET_ENABLED=true requires CIRCLE_BASE_SEPOLIA_WALLET_ID and " +
          "CIRCLE_BASE_SEPOLIA_WALLET_ADDRESS (run scripts/circle-create-base-sepolia-wallet)"
      );
    }
    const testnetScheme = new ExactEvmScheme(
      createCircleEvmSigner(testnetWalletId, testnetAddress as `0x${string}`, "test")
    );
    client.register(TESTNET_NETWORK, testnetScheme);
    console.log(`[X402] Base Sepolia leg registered (Circle TEST wallet: ${testnetAddress})`);
  }

  // Solana signer: Circle DCW (SOLANA_SIGNER_BACKEND=circle) or a local keypair.
  // Circle keeps the key out of the deployment and matches how Base is signed;
  // the local key stays supported so the switch can be reverted from env alone.
  const solanaBackend = resolveSolanaBackend();
  let svmSigner: TransactionPartialSigner | undefined;

  if (solanaBackend === "circle") {
    const circleSolana = getCircleSolanaSignerFromEnv();
    if (circleSolana) {
      svmSigner = circleSolana.signer;
      _solanaPayerAddress = circleSolana.address;
      console.log(`[X402] Using Circle DCW signer for Solana (wallet: ${circleSolana.address})`);
    }
  } else if (solanaBackend === "privatekey") {
    // SOLANA_PRIVATE_KEY: base58-encoded 64-byte keypair (32-byte seed + 32-byte pubkey)
    const keyBytes = base58.decode(process.env.SOLANA_PRIVATE_KEY as string);
    const localSigner = await createKeyPairSignerFromBytes(keyBytes);
    svmSigner = localSigner;
    _solanaPayerAddress = localSigner.address;
    console.log(`[X402] Using local keypair signer for Solana (${localSigner.address})`);
  }

  if (svmSigner) {

    // registerExactSvmScheme constructs `new ExactSvmScheme(signer)` with no
    // config, so the v2 leg always builds its transaction against the default
    // public RPC (https://api.mainnet-beta.solana.com). That endpoint rate-limits
    // server traffic, and a failure there aborts the payment — the 402 then flows
    // back to the caller with the empty v2 body, which is what "HTTP 402: {}"
    // against Solana-only endpoints looks like.
    //
    // Register the v2 scheme ourselves so a dedicated RPC can be supplied. The
    // helper still handles the v1 registrations, and re-registering "solana:*"
    // afterwards overrides its RPC-less instance.
    const rpcUrl = process.env.SOLANA_RPC_URL;
    registerExactSvmScheme(client, { signer: svmSigner });
    if (rpcUrl) {
      client.register("solana:*", new ExactSvmScheme(svmSigner, { rpcUrl }));
      console.log(`[X402] Solana RPC override active: ${new URL(rpcUrl).host}`);
    } else {
      console.warn(
        "[X402] SOLANA_RPC_URL not set — Solana payments use the public " +
          "api.mainnet-beta.solana.com endpoint, which rate-limits server traffic"
      );
    }
    console.log(`[X402] Solana SVM scheme registered (address: ${svmSigner.address})`);
  } else {
    console.log(
      "[X402] No Solana signer configured — Solana endpoints will be skipped " +
        "(set SOLANA_PRIVATE_KEY, or SOLANA_SIGNER_BACKEND=circle with the CIRCLE_SOLANA_* vars)"
    );
  }

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
