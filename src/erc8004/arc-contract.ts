/**
 * ERC-8004 on Arc の定数。Testnet ↔ mainnet は ARC_NETWORK で切替(既定 testnet)。
 *
 * 出典(一次情報): 指示書に記載の Arc docs / register-your-first-ai-agent チュートリアル。
 * これらの値は Arc docs 由来としてユーザーが確認済みのものを転記している(憶測ではない)。
 * 実行前に use-arc Skill / Arc の contract-addresses ページで最終確認すること。mainnet の
 * registry / RPC は Arc の contract-addresses ページで確認し、違えば env で上書きする。
 *
 * 注意: Base の IdentityRegistry(0x8004A169...) は register() (引数なし)だが、Arc の
 * IdentityRegistry は register(string metadataURI) で ERC-8004 のバージョンが異なる。
 * 混同しないよう Base 用(erc8004/contract.ts)とは別モジュールにしている。
 */

export type ArcNetwork = "mainnet" | "testnet";

/** 選択中の Arc ネットワーク。ARC_NETWORK=mainnet で本番、未設定は testnet(既定)。 */
export const ARC_NETWORK: ArcNetwork =
  process.env.ARC_NETWORK === "mainnet" ? "mainnet" : "testnet";
const MAINNET = ARC_NETWORK === "mainnet";

/**
 * RPC。ARC_RPC が最優先。testnet は後方互換で ARC_TESTNET_RPC も読む。
 * mainnet の既定 URL は Arc 公式で最終確認し、違えば ARC_RPC で上書きすること。
 */
export const ARC_RPC =
  process.env.ARC_RPC ??
  (MAINNET
    ? "https://rpc.arc.network/"
    : process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network/");
/** @deprecated ARC_RPC を使う。既存呼び出しの後方互換のため残置(同一値)。 */
export const ARC_TESTNET_RPC = ARC_RPC;

export const ARC_EXPLORER =
  process.env.ARC_EXPLORER ?? (MAINNET ? "https://arcscan.app" : "https://testnet.arcscan.app");
export const ARC_FAUCET = "https://faucet.circle.com";

/** Circle Developer-Controlled Wallet の blockchain 識別子。mainnet=ARC / testnet=ARC-TESTNET。 */
export const ARC_CIRCLE_BLOCKCHAIN =
  process.env.ARC_CIRCLE_BLOCKCHAIN ?? (MAINNET ? "ARC" : "ARC-TESTNET");

/**
 * ERC-8004 コントラクト。ERC-8004 リファレンス実装は決定的(CREATE2)アドレスなので mainnet も
 * 同一の可能性が高いが、Arc の contract-addresses ページで必ず確認し、違えば env で上書きする。
 * 既定値は Arc Testnet の確認済みアドレス。
 */
export const ARC_IDENTITY_REGISTRY =
  process.env.ARC_IDENTITY_REGISTRY ?? "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const ARC_REPUTATION_REGISTRY =
  process.env.ARC_REPUTATION_REGISTRY ?? "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const ARC_VALIDATION_REGISTRY =
  process.env.ARC_VALIDATION_REGISTRY ?? "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";

/** ERC-721 Transfer(topic0) — 標準・chain 非依存。Base 用と同一。 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_TOPIC =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * register(string metadataURI) の Solidity 関数シグネチャ(型のみ)。Circle DCW の
 * abiFunctionSignature に渡す。確定値(Arc 公式 docs): register(string metadataURI)。
 */
export const ARC_REGISTER_ABI_SIGNATURE = "register(string)";

/**
 * 当面の metadataURI 既定値(register-your-first-ai-agent チュートリアルの例 IPFS URI)。
 * まずこれで疎通確認し、後で AA の agent card(ipfs://)に差し替える。
 * ARC_METADATA_URI 環境変数で上書き可能。
 */
export const ARC_TUTORIAL_METADATA_URI =
  "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

/** metadataURI を解決する。ARC_METADATA_URI があればそれ、無ければ例 IPFS URI。 */
export function resolveMetadataURI(): string {
  return process.env.ARC_METADATA_URI ?? ARC_TUTORIAL_METADATA_URI;
}

export function arcTxUrl(txHash: string): string {
  return `${ARC_EXPLORER}/tx/${txHash}`;
}

/** Arc の native gas token が市場価格を持たないか(faucet トークン)。testnet のみ true。
 *  mainnet(ARC)は実価格なので gas-budget が ERC8004_GAS_USD_PER_NATIVE を要求する(fail loud)。 */
export const ARC_GAS_IS_FAUCET = !MAINNET;

/**
 * ReputationRegistry / ValidationRegistry の関数・event シグネチャ。
 * 一次確認: erc-8004/erc-8004-contracts の abis/ReputationRegistry.json /
 * abis/ValidationRegistry.json(型順を ABI から転記。憶測ではない)。
 */
// giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1,
//              string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)
export const ARC_GIVE_FEEDBACK_SIG =
  "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)";
// NewFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex, int128 value,
//   uint8 valueDecimals, string indexedTag1, string tag1, string tag2, string endpoint,
//   string feedbackURI, bytes32 feedbackHash) — feedbackIndex は非indexed data の先頭
export const ARC_NEW_FEEDBACK_EVENT =
  "NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)";
// validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)
export const ARC_VALIDATION_REQUEST_SIG =
  "validationRequest(address,uint256,string,bytes32)";
// validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)
export const ARC_VALIDATION_RESPONSE_SIG =
  "validationResponse(bytes32,uint8,string,bytes32,string)";
