# src/poc/ ランブック — Circle-DCW-Solana署名ゲート & pay-once 実測

対象: 運用者（egress要）。目的: AA v2 の2つのegress作業を、どの環境からでも迷わず走れる形にする。
1. Circle `signTransaction` PoC（ゲート (ii)encoding / Q3 feePayer≠wallet）
2. `pay-once` を JIN/OSD に叩き、policy修正がv1 legで効くかの実測（(c)の実体）

前提の確定事実（この環境で実型検証済み・push `d2df17e`）:
- Q1（Circle外部tx署名）: SDK v10.8.0 型でYES（`initiateDeveloperControlledWalletsClient(...).signTransaction`、SOL対応、rawTransaction=base64）。
- Q2(i)serialize `getBase64EncodedWireTransaction` / (iii)`SignatureDictionary`差し込み: 実型＋モック実行で確定。
- import は pin済みリポの一次サーフェス `@solana/kit` 一本（サブパッケージ直importはこのリポで解決不可）。
- 残ゲート: (ii)Circle署名encoding、Q3。実API必須。本ランブックで潰す。

> 注: 本ランブックが参照する設計メモ（`aa-v2-redesign.md` / `poc-circle-solana-signing.md` /
> `jin-x402-rebuild-handoff.md`）はリポ外の handoff 文書。運用者が別途保持している版を正とする。

## ★実測結果（2026-07-11）: ゲートA **成立**（on-chain 確定）

Circle DCW（Solana）署名で X-alpha `/claims/active` を **pay→200**、solscan で着金確認。
残ゲート (ii)encoding / Q3(feePayer≠wallet) は **YES（実地）**。

- tx（base58）: `3ccb95HKM3a9e2WsSgy6vhvsTJqqunBjnz58qjeEfoSrD3rCzhE7RcBksQ4Q1hwGwohgpA7V6hW1CcVe3fFzfynx`
- payer: `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY`（Circle DCW ウォレット。生keypair `6JKVug…` ではない）
- 着金: `7PV… → 4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf`（payTo）へ **0.01 USDC**、solscan Transfers に TRANSFER 成立
- facilitator: `{"success":true, network:"solana:5eykt…", payer:"7PV…"}`、HTTP 200、本文（claims）取得
- 確認済み: Q1(外部tx署名)/Q2(kit⇄Circleアダプタ)/(ii)(base58署名が on-chain で有効)/Q3(feePayer≠wallet が settle)
- 実行: `node dist/poc/run-circle-pay.js`（署名器=`circleSolanaSigner`）

→ 分岐は **成立側**: 決済層を Circle DCW（Solana）に寄せられる。設計メモ §3.2/§4 に「成立」で書き戻す。

---

## A. Circle signTransaction PoC（v2ゲートの本命）

> **編集不要で走らせる**: A-2/A-3 を1本にした実スクリプトを同梱済み。env（A-1）を入れたら:
> ```
> TEST_URL=https://x-alpha-zeta.vercel.app/claims/active node dist/poc/run-circle-poc.js
> ```
> → `[4] ✓ X-PAYMENT payload 構築 成功` が出れば (ii)/Q3 YES。throw したらエラー全文が判定材料
> （feePayer系=Q3 NO / encoding系=(ii)）。下の A-2〜A-5 は手で追う場合の内訳。

### A-1. 前提と env（変数名は実コードで確定・既存規則に準拠）
Circle Developer Console で SVM対応(SOL) の Developer-Controlled Wallet を1つ用意（entity secret登録済み）。

**認証情報は既存の LIVE を再利用（新規追加しない）** — EVM DCW `0xAE7C…` が毎日使っている値。
`src/circle/client.ts` が `CIRCLE_API_KEY`（`getRequiredApiKey`）と `CIRCLE_ENTITY_SECRET`
（`buildEntitySecretCiphertext`）を読む。**PoC ウォレットは Console Mainnet なので LIVE を使う。
`CIRCLE_API_KEY_TEST`/`CIRCLE_ENTITY_SECRET_TEST`（Arc Testnet 用）を使わないこと**（混同すると 156005/156006）。

ウォレットの env は既存の Circle 命名規則（EVM は `CIRCLE_EVM_WALLET_ID`/`CIRCLE_EVM_WALLET_ADDRESS`）
に合わせ、Solana は `CIRCLE_SOLANA_WALLET_ID`（既存・.env.example にあり）＋ その対 `CIRCLE_SOLANA_WALLET_ADDRESS`
を使う（generic な `SOLANA_WALLET_ADDRESS` は raw keypair 側の慣習と衝突するため避ける）。
Railway に追加するのはこの2つだけ:
```
CIRCLE_SOLANA_WALLET_ID=<Circle Solana wallet の walletId>
CIRCLE_SOLANA_WALLET_ADDRESS=<その Solana address>
# CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET は既存 LIVE を再利用(追加しない)
```
注: committed の `verify-adapter.ts` は env を読まない（mock＋固定値）。実 env 参照は
下の A-2/A-3 の編集で導入する。読む変数名を上記に一致させること。

### A-2. mock を実 Circle に差す
`src/poc/verify-adapter.ts` の `mockCircle` を実クライアントに置換（これだけ）:
```ts
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { base58 } from "@scure/base"; // ※ @scure/base はこのリポの既存依存(src/x402.ts でも使用)

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});
const client: CircleSignTransactionClient = {
  signTransaction: (i) => circle.signTransaction(i), // { walletId, rawTransaction } => { data:{ signature } }
};
```

### A-3. fake tx を実402 v2 leg に差し、payload構築を @x402/svm に委譲
fake tx の手組みをやめ、X-alphaの実402から payload を組む:
```ts
// 1) 402取得（pay-once.js と同じ経路）
//    X-alpha /claims/active を無支払いGET → PAYMENT-REQUIRED decode → v2 leg を選ぶ
const v2leg = /* decodeした accepts から network が "solana:" で始まる leg */;

// 2) アダプタ（base58注入つき）
const signer = circleSolanaSigner(
  client,
  process.env.CIRCLE_SOLANA_WALLET_ID!,
  process.env.CIRCLE_SOLANA_WALLET_ADDRESS!,
  (s) => base58.decode(s),          // (ii) encoding が base58 の場合のフック
);

// 3) payload構築を svm scheme に委譲（自前で組まない）
import { ExactSvmScheme } from "@x402/svm";
const scheme = new ExactSvmScheme(signer);
const payload = await scheme.createPaymentPayload(2, v2leg);
//   → 内部で partiallySignTransactionMessageWithSigners がアダプタ経由でCircleに署名要求
//   → 返り署名を tx に差し込み → X-PAYMENT(base64) を構築
console.log("X-PAYMENT built:", !!payload);
```

### A-4. 判定（実払い不要でここまでで可否が出る）
- **X-PAYMENT が組めた** → (ii)(Q3) YES。Circle-DCW-Solana署名は成立。
  - このまま `pay-once` 相当に X-PAYMENT を付けて再GET → 200 → solscanで着金まで取れば確証。
- **`createPaymentPayload` が署名段で throw**:
  - `not 64-byte base64 ... pass a base58Decode` → (ii): encoding が base58。A-2で `base58.decode` 注入を確認（上の例で対応済み）。それでも非64byteなら encoding を実レスポンスで確認しアダプタを合わせる。
  - Circle API が `wallet must be fee payer` 系エラー → **Q3 NO**: Circle が feePayer≠wallet のtxを署名拒否。→ §分岐へ。
  - それ以外の invalidReason は生値を記録。

### A-5. 分岐（結果を設計メモ §3.2/§4 に書き戻す）
| 結果 | 次 |
|---|---|
| 成立(X-PAYMENT組める) | `fromConfig`＋`ExactSvmScheme(circleSolanaSigner)` で決済層差し替え。`pay-once` で X-alpha/OSD/JIN 実測→daily切替。EVM/Solana/Arc を DCW 統一。 |
| 不成立(ii) | encoding をアダプタで実値に合わせ再試行。解消不可なら生keypair継続。 |
| 不成立(Q3) | Solana は生keypair継続（`2LS9cuX…` 実績）。Circle統合は EVM/Arc 先行。PayAI以外の feePayer 戦略を別途検討。 |

---

## B. pay-once を JIN/OSD に叩く（(c) の実体）

policy修正（`c4b673b`）がv1 legで本番実際に効くかの実測。X-alphaはv2 leg(header)で実証済みだが、JIN/OSDは body v1 leg なので経路が違う（jin-x402-rebuild-handoff §7c）。

### B-1. 前提
AAリポに `c4b673b`＋`71b2a29`（pay-once）込みで再デプロイ済み。本番env（`SIGNER_BACKEND=circle` 等）設定済み。

### B-2. 実行
```
# JIN
TEST_URL=<JIN movers URL> node dist/pay-once.js
# OSD
TEST_URL=<OSD Solana endpoint URL> node dist/pay-once.js
```

### B-3. 判定（3段ブロッカーモデル）
- 段①: ログの `filtered out by policies for x402 version: 1` が**消えていること**（policy修正が本番で効いた証拠）。
- 段②: `Failed to create payment payload` で止まるなら v1 legの `extra.feePayer` 欠落を疑う（JINは4段fallbackで充足済みのはず）。
- 段③: verify落ち `invalid_payment_requirements` なら v1 legの top-level `resource`/`description`/`maxTimeoutSeconds` 欠落（JIN/OSDは横展開前なら想定どおりの赤）。
- 200 → `PAYMENT-RESPONSE` の base58 tx を solscan照合（6JKVug→4s8X、0.01/0.02 USDC、Success）。

### B-4. 出力を貼る
段①の `filtered out` 有無・`PAYMENT-RESPONSE` decode の `stage`/`invalidReason`・掴んだ leg の生JSON。これを正典leg形（jin-x402-rebuild §7b）と突き合わせ、JINスキーマ充足の残1コミットを書き写しで確定する。

---

## C. 原則（両作業共通）
- 手動最小クライアントの結果を本番の証拠にしない。可否確定後の実測は本番経路（`pay-once` = policyを積むクライアント）で。
- 確定は実物（実API応答・オンチェーン着金）にだけ置く。X-PAYMENTが組めた/200が返った/着金した、を段階ごとに分けて記録する。
- 結果はすべて設計メモ（§3.2/§4）と引き継ぎ書（§5/§7）に事実として書き戻す。

## D. 参照
- アダプタ: `src/poc/circle-solana-signer.ts`（kit一本import、base58注入口つき）
- 検証: `src/poc/verify-adapter.ts`（モック→実Circle差し替えはA-2）
- 設計: `aa-v2-redesign.md` §3.2/§4、`poc-circle-solana-signing.md`（リポ外 handoff）
- 実測: `jin-x402-rebuild-handoff.md` §5/§7b/§7c（リポ外 handoff）
- 確定値: payTo `4s8XQC…`、USDC mint `EPjFWdd5…`、facilitator `https://facilitator.payai.network`、既存実績 tx `2LS9cuX…`
