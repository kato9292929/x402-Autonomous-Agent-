/**
 * ERC-8004 IdentityRegistry — Base mainnet constants and ABI fragments.
 * Source: https://github.com/erc-8004/erc-8004-contracts
 *
 * Verified address: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (Base mainnet, chainId 8453)
 * Same vanity address pattern as other chains (0x8004A1...).
 */

export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const BASE_CHAIN_ID = 8453;

/**
 * Base mainnet ReputationRegistry。
 * 一次確認(2026-08-18): erc-8004/erc-8004-contracts の README 記載のデプロイ表。
 * mainnet 共通の vanity アドレス(0x8004BAa1…)で、IdentityRegistry(0x8004A169…)と同じ系列。
 *
 * UNVERIFIED(ライブ未検証): 当該アドレスのコード存在・稼働は Base RPC への egress が
 * 遮断されているため未確認。環境Bで eth_getCode 等により確定させること。
 */
export const BASE_REPUTATION_REGISTRY =
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

/**
 * Base mainnet ValidationRegistry は「未採取」。
 * 一次確認(2026-08-18): 同 README のデプロイ表に ValidationRegistry の記載が無く、
 * 仕様側も "The Validation Registry portion of the ERC-8004 spec is still under active
 * update and discussion with the TEE community" として流動的である旨を明記している。
 * → Base での validation 書き込みは対象外。推測でアドレスを置かない。
 */
export const BASE_VALIDATION_REGISTRY = undefined;

// ERC-721 Transfer event topic0
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

// Minimal ABI fragments (derived from official abis/IdentityRegistry.json)
export const IDENTITY_REGISTRY_ABI = [
  {
    inputs: [],
    name: "register",
    outputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "string", name: "newURI", type: "string" },
    ],
    name: "setAgentURI",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "getAgentWallet",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// agentRegistry identifier per ERC-8004 spec
export const AGENT_REGISTRY_ID =
  `eip155:${BASE_CHAIN_ID}:${IDENTITY_REGISTRY}` as const;
