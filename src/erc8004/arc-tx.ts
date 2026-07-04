/**
 * Arc Testnet 汎用トランザクションヘルパ(Circle DCW TEST 認証)。
 *
 * reputation / validation の contractExecution で使う(任意の walletId / contractAddress /
 * 関数)。M0 の arc-executor.ts(identity 登録)は無変更で残し、こちらは独立した汎用版。
 * 認証は arc-test-client(CIRCLE_API_KEY_TEST / CIRCLE_ENTITY_SECRET_TEST)。LIVE は参照しない。
 */
import * as crypto from "node:crypto";
import { CIRCLE_API } from "../circle/client";
import {
  getRequiredArcTestApiKey,
  buildArcTestEntitySecretCiphertext,
} from "../circle/arc-test-client";
import { ARC_CIRCLE_BLOCKCHAIN, ARC_TESTNET_RPC } from "./arc-contract";

export interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
}

export async function arcRpc<T>(method: string, params: unknown[]): Promise<T> {
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

export function getOwnerWalletId(): string {
  const id = process.env.CIRCLE_ARC_OWNER_WALLET_ID;
  if (!id) throw new Error("CIRCLE_ARC_OWNER_WALLET_ID is required (Arc owner ウォレット)");
  return id;
}

export function getValidatorWalletId(): string {
  const id = process.env.CIRCLE_ARC_VALIDATOR_WALLET_ID;
  if (!id) throw new Error("CIRCLE_ARC_VALIDATOR_WALLET_ID is required (Arc validator ウォレット)");
  return id;
}

export function getValidatorAddress(): string {
  const a = process.env.ARC_VALIDATOR_ADDRESS;
  if (!a) throw new Error("ARC_VALIDATOR_ADDRESS is required (validator ウォレットのアドレス)");
  return a;
}

/** 任意の contract 関数を Circle DCW(TEST)で実行し txId を返す。 */
export async function submitContractExecution(opts: {
  walletId: string;
  contractAddress: string;
  abiFunctionSignature: string;
  abiParameters: unknown[];
}): Promise<string> {
  const apiKey = getRequiredArcTestApiKey();
  const entitySecretCiphertext = await buildArcTestEntitySecretCiphertext(apiKey);

  const body = {
    idempotencyKey: crypto.randomUUID(),
    walletId: opts.walletId,
    blockchain: ARC_CIRCLE_BLOCKCHAIN, // "ARC-TESTNET" を明示
    contractAddress: opts.contractAddress,
    abiFunctionSignature: opts.abiFunctionSignature,
    abiParameters: opts.abiParameters,
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
    throw new Error(`Arc contractExecution failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: { id?: string } };
  const txId = json.data?.id;
  if (!txId) throw new Error("Arc contractExecution: no transaction id in response");
  return txId;
}

export async function waitForTxHash(
  txId: string,
  maxWaitMs = 180_000,
  pollMs = 3_000
): Promise<string> {
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

export async function getReceiptLogs(txHash: string): Promise<RpcLog[]> {
  const receipt = await arcRpc<{ logs?: RpcLog[] } | null>("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error(`Arc receipt not found for ${txHash}`);
  return receipt.logs ?? [];
}
