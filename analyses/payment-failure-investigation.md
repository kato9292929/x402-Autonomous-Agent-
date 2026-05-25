# AA Payment Failure Investigation (2026-05-25)

## 症状まとめ

| エラー | 対象 endpoint 数 | エラー内容 |
|---|---|---|
| A | 1 (APAC Macro Dashboard) | `payTo regex error` |
| B | 7 | `Failed to verify payment: unexpected_error` |
| C | 2 (Portfolio Intelligence / Japan Real Estate) | `Unexpected non-whitespace character after JSON at position 4` |

wallet: USDC 5残、ETH 1.5USD、tx 送信 0 回。

---

## 根本原因の特定

### エラー C: "Unexpected non-whitespace character after JSON at position 4"

**該当コード**: `src/caller.ts` の `const data = (await res.json())`

この SyntaxError が発生するのは、response body が `null{...}` (null の直後に JSON オブジェクトが続く) 形式のときのみ。

```
node -e "JSON.parse('null{}')"
// SyntaxError: Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)
node -e "JSON.parse('null\n')"
// → OK (null はそのまま返る)
```

**発生箇所の特定**:

`wrapFetchWithPayment` (x402-fetch の内部処理) は 402 レスポンスボディを以下でパースする:
```javascript
const { x402Version, accepts } = await response.json();
```
Portfolio Intelligence (POST) と Japan Real Estate (GET with `?area=tokyo`) だけがこの形式で返っている可能性が高い。エラーは caller.ts の `await res.json()` ではなく、`wrapFetchWithPayment` 内部の `response.json()` で throw されており、それが catch ブロックへ伝播していると考えられる。

**仮説**: これら 2 endpoint のサーバーが 402 レスポンスボディを `null{...}` 形式で返している (サーバーサイドの x402 middleware バグ or レスポンス多重化)。

**修正案**: テストスクリプトで実際の 402 ボディを確認する (`res.text()` で生取得)。

---

### エラー B: "Failed to verify payment: unexpected_error"

**エラーメッセージの出処**: `x402/dist/cjs/verify/index.js` の `VerifyError` クラス。
```javascript
// verify/index.js
class VerifyError extends Error {
  constructor(statusCode, response) {
    super(
      response.invalidReason 
        ? `Failed to verify payment: ${response.invalidReason}`
        : `Failed to verify payment: ${statusCode}`
    );
  }
}
```
`invalidReason = "unexpected_error"` → facilitator (x402.org 側) が返している非標準エラー。

**注意**: x402 の標準 ErrorReasons に `"unexpected_error"` は含まれていない。含まれているのは `"unexpected_verify_error"` と `"unexpected_settle_error"`。つまりこれは x402 library 外部の facilitator サービスが返している独自エラー。

**`LocalAccount` による `network = undefined` 問題**:

`src/x402.ts` で `privateKeyToAccount` を使っている:
```typescript
const account = privateKeyToAccount(privateKey as `0x${string}`);
export const fetchWithPayment = wrapFetchWithPayment(fetch, account as unknown as Signer, ...);
```

`wrapFetchWithPayment` 内部では signer type によって network を決定する:
```javascript
// x402-fetch/dist/cjs/index.js line 41
const network = isMultiNetworkSigner(walletClient) ? void 0
  : import_types.evm.isSignerWallet(walletClient) ? ChainIdToNetwork[walletClient.chain?.id]
  : isSvmSignerWallet(walletClient) ? ["solana", "solana-devnet"]
  : void 0;  // ← LocalAccount はここに落ちる → network = undefined
```

実機確認済み:
```
evm.isSignerWallet(LocalAccount) = false
evm.isAccount(LocalAccount)      = true   ← 署名自体はできる
network                           = undefined
```

`network = undefined` で `selectPaymentRequirements` を呼ぶと Base だけでなく全ネットワークの requirement が候補になる。現状は USDC アドレスマッチングで Base mainnet が選ばれるはずだが、facilitator が "unexpected_error" を返す原因として chain context の欠如が疑われる。

**`createSigner` (x402-fetch の正式 API) との差分**:
```javascript
// createSigner が返すのは SignerWallet (viem Client with chain)
evm.isSignerWallet(createSigner("base", pk)) = true
ChainIdToNetwork[wallet.chain.id]             = "base"  ← 明示的に chain が渡る
```

---

### エラー A: "payTo regex error" (APAC Macro Dashboard)

サーバーサイドの x402 middleware が `payTo` アドレスを正規表現で検証しているが、このエンドポイントだけ `payTo` の形式が無効 (例: checksum なし、または Solana 形式のアドレス)。**AA 側では解決不可・サーバー側修正待ち。**

---

## 修正案

### Fix 1: `LocalAccount` → `createSigner` (最優先)

**対象**: `src/x402.ts`

```typescript
// Before (問題あり)
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(privateKey as `0x${string}`);
export const fetchWithPayment = wrapFetchWithPayment(fetch, account as unknown as Signer, BigInt(3_000_000));

// After (createSigner で SignerWallet を生成)
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const signer = await createSigner("base", privateKey);
export const fetchWithPayment = wrapFetchWithPayment(fetch, signer, BigInt(3_000_000));
```

しかし `createSigner` が async なため、module-level での同期初期化ができない。
対策: `initX402Fetch()` パターンに戻す (index.ts の `await initX402Fetch()` 復活)。

### Fix 2: caller.ts で `res.ok` チェック + 生テキストフォールバック

**対象**: `src/caller.ts`

```typescript
const res = await fetchWithPayment(ep.url, options);

// HTTP ステータス確認
if (!res.ok) {
  const text = await res.text().catch(() => "(no body)");
  throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
}

const data = (await res.json()) as Record<string, unknown>;
```

これで「JSON パースエラー」ではなく「HTTP 4xx/5xx + body」という具体的なエラーが出るようになる。

### Fix 3: type declaration の整合 (副次的)

`src/types/x402-fetch.d.ts` の `createSigner` を async に戻す:
```typescript
export function createSigner(network: string, privateKey: string): Promise<Signer>;
```
既にこの定義になっているので問題なし。

---

## テスト方法

```bash
# ローカルで手動実行 (PAYMENT_PRIVATE_KEY を .env に設定した状態)
node dist/test-payment.js

# 出力で確認すること:
# - signer address が正しいか
# - 402 challenge の accepts[0].network が "base" か
# - signed payment header が base64 エンコードされているか
# - second response のステータスコードと body
```

---

## 優先度

1. **Fix 1** (createSigner に戻す) → 7 endpoint の "unexpected_error" 解消見込み
2. **Fix 2** (res.ok チェック) → エラーログが具体的になる
3. エラー C の実際のサーバーレスポンス確認 → テストスクリプトで
4. エラー A (payTo regex) → サーバー側対応待ち
