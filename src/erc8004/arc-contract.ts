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
 * ERC-8004 コントラクトのアドレス。
 *
 * 既定値は Arc **Testnet** の確認済みアドレス(testnet vanity 0x8004A818… / 0x8004B663…)。
 * mainnet は既定を持たせない(空文字)。理由(2026-09-17 一次確認):
 *  - ERC-8004 公式 curated リポ(erc-8004/erc-8004-contracts)の deployment 表に **Arc mainnet の
 *    行は無い**。mainnet vanity 0x8004A169… / 0x8004BAa1… は Ethereum / Base 等のもので、
 *    Arc mainnet の ERC-8004 は未デプロイ(mainnet の vanity プロキシは MinimalUUPS placeholder で
 *    register() 未実装との報告あり)。
 * したがって testnet アドレスを mainnet に流用してはならない(誤登録・実 gas の浪費になる)。
 * Arc mainnet に ERC-8004 が正式デプロイされ確定アドレスが公表されたら、ARC_IDENTITY_REGISTRY 等を
 * env で与えること。未設定のまま mainnet 登録を試みると assertArcRegistrable() が停止させる。
 */
export const ARC_IDENTITY_REGISTRY =
  process.env.ARC_IDENTITY_REGISTRY ?? (MAINNET ? "" : "0x8004A818BFB912233c491871b3d84c89A494BD9e");
export const ARC_REPUTATION_REGISTRY =
  process.env.ARC_REPUTATION_REGISTRY ?? (MAINNET ? "" : "0x8004B663056A597Dffe9eCcC1965A193B7388713");
export const ARC_VALIDATION_REGISTRY =
  process.env.ARC_VALIDATION_REGISTRY ?? (MAINNET ? "" : "0x8004Cb1BF31DAf7788923b405b754f57acEB4272");

/**
 * Arc mainnet で実際に登録可能かを検査する門番。前提が未達なら throw(実 gas を無駄にしないため)。
 * testnet は常に通過する。register / create-wallets の実行経路の先頭で呼ぶ。
 *
 * 2026-09-17 時点で mainnet 登録を阻む外部要因(いずれも「出遅れ」ではなく相手側の未対応):
 *  1. Arc mainnet に ERC-8004 IdentityRegistry の確定アドレスが未公表(未デプロイ / placeholder)。
 *  2. Circle DCW の mainnet 対応チェーン一覧に ARC が無い(ARC-TESTNET のみ)→ 署名用ウォレット未作成。
 * これらが解消され env(ARC_IDENTITY_REGISTRY / ARC_CIRCLE_BLOCKCHAIN=ARC)が揃えば通過する。
 */
export function assertArcRegistrable(): void {
  if (!MAINNET) return;
  const problems: string[] = [];
  if (!process.env.ARC_IDENTITY_REGISTRY) {
    problems.push(
      "ARC_IDENTITY_REGISTRY 未設定: Arc mainnet の ERC-8004 IdentityRegistry 確定アドレスを設定してください" +
        "(testnet の 0x8004A818… を mainnet に流用しない。ERC-8004 公式 deployment 表に Arc mainnet 行は未掲載)。"
    );
  }
  if (ARC_CIRCLE_BLOCKCHAIN !== "ARC") {
    problems.push(
      `ARC_CIRCLE_BLOCKCHAIN が "ARC" ではありません(=${ARC_CIRCLE_BLOCKCHAIN})。` +
        "Circle DCW が ARC(mainnet)ウォレット作成に対応してから設定してください。"
    );
  }
  if (problems.length > 0) {
    throw new Error(
      "[ARC] Arc mainnet 登録の前提が未達のため停止します(実 gas を無駄にしないための門番):\n - " +
        problems.join("\n - ") +
        "\n解消条件: (1) Arc mainnet に ERC-8004 が正式デプロイされ確定アドレスが公表される、" +
        "(2) Circle DCW が ARC(mainnet)ウォレット作成に対応する。両方揃えば ARC_NETWORK=mainnet で登録可能。"
    );
  }
}

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
