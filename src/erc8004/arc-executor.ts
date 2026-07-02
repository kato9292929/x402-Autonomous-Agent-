/**
 * Arc Testnet 向け ERC-8004 identity 登録 — Circle Developer-Controlled Wallet 版。
 *
 * 既存の Base 版(erc8004/executor.ts)と同じ思想: Circle の contractExecution API で
 * owner ウォレット(msg.sender)から register(metadataURI) を呼ぶ。tx 確定後、agentId は
 * ERC-721 Transfer(from=0x0, to=owner, tokenId=agentId) イベントから取り出す。
 * receipt は Arc RPC(JSON-RPC eth_getTransactionReceipt)を直接叩いて取得する(viem の
 * chain 定義に依存しないので Arc の chainId 未確定でも動く)。
 *
 * 実行には Arc 用の Circle TEST 認証(CIRCLE_API_KEY_TEST / CIRCLE_ENTITY_SECRET_TEST)と
 * ARC-TESTNET の owner ウォレット(CIRCLE_ARC_OWNER_WALLET_ID、ガス用 testnet USDC 済み)が
 * 必要。AA 本体の LIVE 認証(CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET)は使わない・触らない。
 *
 * 確定値(Arc 公式 docs / register-your-first-ai-agent 由来):
 *  - contractExecution では blockchain "ARC-TESTNET" を明示で渡す(walletId 由来の chain
 *    推定に頼らない)。
 *  - register の ABI は register(string metadataURI) → abiFunctionSignature "register(string)"。
 */
import * as crypto from "node:crypto";
import { CIRCLE_API } from "../circle/client";
import {
  getRequiredArcTestApiKey,
  buildArcTestEntitySecretCiphertext,
} from "../circle/arc-test-client";
import {
  ARC_CIRCLE_BLOCKCHAIN,
  ARC_IDENTITY_REGISTRY,
  ARC_REGISTER_ABI_SIGNATURE,
  ARC_TESTNET_RPC,
  TRANSFER_TOPIC,
  ZERO_TOPIC,
} from "./arc-contract";

export interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
}

/**
 * receipt.logs から ERC-721 mint(Transfer from 0x0)の tokenId(=agentId)を取り出す純関数。
 * 見つからなければ null。tokenId は 4番目の indexed topic(topics[3])。
 */
export function extractAgentIdFromLogs(
  logs: RpcLog[],
  registry: string = ARC_IDENTITY_REGISTRY
): string | null {
  const mint = logs.find(
    (l) =>
      l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics?.[1] === ZERO_TOPIC &&
      Boolean(l.topics?.[3]) &&
      (!l.address || l.address.toLowerCase() === registry.toLowerCase())
  );
  if (!mint?.topics?.[3]) return null;
  return BigInt(mint.topics[3]).toString();
}

async function arcRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ARC_TESTNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Arc RPC ${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`Arc RPC ${method} error: ${json.error.message}`);
  return json.result as T;
}

function getOwnerWalletId(): string {
  const id = process.env.CIRCLE_ARC_OWNER_WALLET_ID;
  if (!id) {
    throw new Error(
      "CIRCLE_ARC_OWNER_WALLET_ID is required (Arc Testnet の owner ウォレット。arc:create-wallets で作成)"
    );
  }
  return id;
}

async function submitArcExecution(
  abiFunctionSignature: string,
  abiParameters: string[]
): Promise<string> {
  const apiKey = getRequiredArcTestApiKey();
  const entitySecretCiphertext = await buildArcTestEntitySecretCiphertext(apiKey);

  const body = {
    idempotencyKey: crypto.randomUUID(),
    walletId: getOwnerWalletId(),
    blockchain: ARC_CIRCLE_BLOCKCHAIN, // "ARC-TESTNET" を明示(chain 推定に頼らない)
    contractAddress: ARC_IDENTITY_REGISTRY,
    abiFunctionSignature,
    abiParameters,
    feeLevel: "MEDIUM",
    entitySecretCiphertext,
  };

  const res = await fetch(`${CIRCLE_API}/developer/transactions/contractExecution`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Arc contractExecution submit failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: { id?: string } };
  const txId = json.data?.id;
  if (!txId) throw new Error("Arc contractExecution: no transaction id in response");
  return txId;
}

async function waitForTxHash(txId: string, maxWaitMs = 180_000, pollMs = 3_000): Promise<string> {
  const apiKey = getRequiredArcTestApiKey();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${CIRCLE_API}/transactions/${txId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        data?: { transaction?: { state?: string; txHash?: string } };
      };
      const tx = json.data?.transaction;
      if ((tx?.state === "CONFIRMED" || tx?.state === "COMPLETE") && tx.txHash) return tx.txHash;
      if (tx?.state === "FAILED" || tx?.state === "DENIED") {
        throw new Error(`Arc transaction ${tx.state}: ${txId}`);
      }
      console.log(`[ARC] waiting... state=${tx?.state ?? "unknown"}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Arc transaction timeout after ${maxWaitMs}ms: ${txId}`);
}

export interface ArcRegistrationResult {
  agentId: string;
  txHash: string;
}

/** IdentityRegistry.register(metadataURI) を owner ウォレットで実行し agentId を取得する。 */
export async function registerArcAgent(metadataURI: string): Promise<ArcRegistrationResult> {
  if (!metadataURI || metadataURI.length < 1) throw new Error("metadataURI is required");

  const txId = await submitArcExecution(ARC_REGISTER_ABI_SIGNATURE, [metadataURI]);
  console.log(`[ARC] contractExecution submitted: ${txId}`);

  const txHash = await waitForTxHash(txId);
  console.log(`[ARC] tx confirmed: ${txHash}`);

  const receipt = await arcRpc<{ logs?: RpcLog[] } | null>("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error(`Arc receipt not found for ${txHash}`);

  const agentId = extractAgentIdFromLogs(receipt.logs ?? []);
  if (!agentId) throw new Error(`Transfer(mint) event not found in Arc receipt ${txHash}`);

  return { agentId, txHash };
}
