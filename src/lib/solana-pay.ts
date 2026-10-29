/**
 * Solana(@x402/svm exact)決済の純ロジック。ネットワーク非依存で単体テスト可能。
 *
 * ここに置くのは「402 の leg 選択」と「多重支払いの構造的禁止(1プロセス1回)」だけ。
 * 実際の署名・RPC・送金は @x402/svm と wrapFetchWithPayment が行う(egress 必須)。
 *
 * leg 選択規則は @x402/core client の実装に一致させている(推測ではない):
 *  - バケットは decoded.x402Version(PAYMENT-REQUIRED ヘッダのトップレベル値)。
 *  - そのバージョンに登録された network に一致する accepts だけを残す。
 *      v2 = "solana:*"(ワイルドカード ^solana:.*$)、v1 = "solana"/"solana-devnet"/"solana-testnet"(完全一致)。
 *  - デフォルト selector は先頭(accepts[0])。
 *  - 金額フィールドは v2=amount / v1=maxAmountRequired。
 * 参照: node_modules/@x402/svm/.../exact/client(register.ts)、@x402/core/.../client(selectPaymentRequirements)。
 */

/** 402 accepts の 1 leg(v1/v2 両形。フィールドは実物に合わせて optional)。 */
export interface SvmLeg {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string; // v2
  maxAmountRequired?: string; // v1
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>; // extra.feePayer など
  resource?: string;
}

/** decode 済み PAYMENT-REQUIRED(PaymentRequired)の最小形。 */
export interface DecodedPaymentRequired {
  x402Version: number;
  accepts: SvmLeg[];
  error?: string;
  resource?: unknown;
}

/** @x402/svm が registerExactSvmScheme で登録する network(実物)。 */
export const SVM_V1_NETWORKS = ["solana", "solana-devnet", "solana-testnet"];
export const SVM_V2_PATTERN = "solana:*";

/** v2=amount / v1=maxAmountRequired を吸収して atomic 金額を返す。 */
export function legAmount(leg: SvmLeg): string | undefined {
  return leg.amount ?? leg.maxAmountRequired;
}

/**
 * @x402/core の findSchemesByNetwork と同じワイルドカード一致。
 * 登録パターン中の "*" のみを ".*" にし、他は正規表現エスケープして完全一致判定する。
 */
export function networkMatches(registeredPattern: string, network: string): boolean {
  const pattern = registeredPattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${pattern}$`).test(network);
}

export interface SelectedLeg {
  leg: SvmLeg;
  index: number; // decoded.accepts 内の位置
  version: number; // 掴んだバケット(=decoded.x402Version)
  matchedPattern: string; // 一致した登録 network パターン
}

/**
 * decoded(PAYMENT-REQUIRED)から、x402Client が実際に掴む leg を忠実に再現する。
 * バケット=decoded.x402Version、v1 は完全一致・v2 は "solana:*"、先頭を選ぶ。
 * SVM leg が無ければ null(呼び出し側で「Solana leg 無し」を明示して停止する)。
 */
export function selectSvmLeg(decoded: DecodedPaymentRequired): SelectedLeg | null {
  if (!decoded || !Array.isArray(decoded.accepts)) return null;
  const patterns = decoded.x402Version === 1 ? SVM_V1_NETWORKS : [SVM_V2_PATTERN];
  for (let i = 0; i < decoded.accepts.length; i++) {
    const leg = decoded.accepts[i];
    const net = leg.network ?? "";
    const matched = patterns.find((p) => networkMatches(p, net));
    if (matched) {
      return { leg, index: i, version: decoded.x402Version, matchedPattern: matched };
    }
  }
  return null;
}

/**
 * 多重支払いを構造的に不可能にする fetch ラッパ。支払いヘッダ(PAYMENT-SIGNATURE / X-PAYMENT)を
 * 帯びた送信は 1 プロセス 1 回まで。2 回目は送信前に throw する。無支払いの GET/hook は無制限。
 * 1 回目の支払いヘッダ生値は getSentPaymentHeader() で取り出せる(失敗時ログ・decode 用)。
 */
export function makeSinglePaymentFetch(baseFetch: typeof fetch): {
  fetch: typeof fetch;
  getSentPaymentHeader: () => { name: string; value: string } | null;
  paymentAttempts: () => number;
} {
  let attempts = 0;
  let sent: { name: string; value: string } | null = null;

  const guarded = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const sig = req.headers.get("PAYMENT-SIGNATURE");
    const xpay = req.headers.get("X-PAYMENT");
    const payHeader = sig
      ? { name: "PAYMENT-SIGNATURE", value: sig }
      : xpay
      ? { name: "X-PAYMENT", value: xpay }
      : null;

    if (payHeader) {
      attempts += 1;
      if (attempts > 1) {
        throw new Error(
          `[SINGLE-PAY GUARD] 2 回目の支払い試行をブロックしました(多重支払い防止)。1 プロセス 1 回のみ。`
        );
      }
      sent = payHeader;
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  return {
    fetch: guarded,
    getSentPaymentHeader: () => sent,
    paymentAttempts: () => attempts,
  };
}
