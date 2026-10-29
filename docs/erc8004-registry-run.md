# ERC-8004 ReputationRegistry / ValidationRegistry 記録

作業指示書 2026-08-18 に対する採取・設計・実装・実行の記録。
**環境B（鍵とネットワークが要る作業）は未消化。** 下記「環境Bの消化状況」を参照。

---

## M0. 一次情報とリポジトリの採取

### M0-1. 仕様（出典付き）

出典: `erc-8004/erc-8004-contracts`（default branch `master`）のコントラクト実装。
登録時に使った版と同じリポジトリ（`contracts/` 配下の Upgradeable 実装）から転記した。

#### ReputationRegistry（`contracts/ReputationRegistryUpgradeable.sol`）

```solidity
function giveFeedback(
    uint256 agentId, int128 value, uint8 valueDecimals,
    string calldata tag1, string calldata tag2, string calldata endpoint,
    string calldata feedbackURI, bytes32 feedbackHash
) external

event NewFeedback(
    uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex,
    int128 value, uint8 valueDecimals, string indexed indexedTag1,
    string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash
)
```

**「所有者は自分のエージェントに reputation を付けられない」の具体的な判定:**

```solidity
require(!IIdentityRegistry(_identityRegistry).isAuthorizedOrOwner(msg.sender, agentId),
        "Self-feedback not allowed");
```

- 判定対象は **`msg.sender`**。`isAuthorizedOrOwner` が **false** のときだけ通る。
- したがって validator ウォレットは **owner でないだけでは不十分**で、対象 agent の
  `approved` / `operator`（ERC-721 の `getApproved` / `isApprovedForAll`）にも
  なっていてはならない。該当すると revert する。

その他の制約: `require(valueDecimals <= 18)` / `require(value >= -MAX_ABS_VALUE && value <= MAX_ABS_VALUE)`。

#### ValidationRegistry（`contracts/ValidationRegistryUpgradeable.sol`）

```solidity
function validationRequest(address validatorAddress, uint256 agentId,
                           string calldata requestURI, bytes32 requestHash) external
function validationResponse(bytes32 requestHash, uint8 response,
                            string calldata responseURI, bytes32 responseHash,
                            string calldata tag) external
```

呼び出し権限（一次確認した require）:

| 関数 | 制約 |
|---|---|
| `validationRequest` | `require(msg.sender == owner \|\| registry.isApprovedForAll(owner, msg.sender) \|\| registry.getApproved(agentId) == msg.sender, "Not authorized")` |
| | `require(validatorAddress != address(0), "bad validator")` / `require($.validations[requestHash].validatorAddress == address(0), "exists")` |
| `validationResponse` | `require(msg.sender == s.validatorAddress, "not validator")` / `require(s.validatorAddress != address(0), "unknown")` |
| | `require(response <= 100, "resp>100")` |

**指示書との差分（重要）:** 指示書は「reputation と validation の書き込みは validator ウォレットからのみ行う」と
しているが、**`validationRequest` は仕様上 owner（または approved）からしか送れない**。validator から送ると
コントラクトが `"Not authorized"` で revert する。そのため:

- `giveFeedback` … **validator のみ**（owner は `"Self-feedback not allowed"` で拒否される）
- `validationRequest` … **owner のみ**（validator は `"Not authorized"` で拒否される）
- `validationResponse` … **validator のみ**

指示書の禁止事項「オーナーウォレットから reputation を書かない」はコントラクト側でも強制されており、
実装はこれを満たす。validationRequest だけは仕様に従い owner から送る（推測で仕様を曲げない）。

**`response` は真偽値ではなく 0-100 の整数。** 従来コードは valid を `1` としていたが、これは
0-100 スケールでは「ほぼ 0 点」を意味してしまうため、根拠が確認できたら `100`、できなければ `0` に修正した。

### M0-2. チェーンごとのレジストリアドレス

| チェーン | IdentityRegistry | ReputationRegistry | ValidationRegistry |
|---|---|---|---|
| Base mainnet (8453) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | **未採取（未公開）** |
| Arc Testnet | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

- Base の Reputation アドレスは `erc-8004-contracts` README のデプロイ表から採取（mainnet 共通 vanity `0x8004BAa1…`）。
- **Base の ValidationRegistry はデプロイ表に記載が無い。** 仕様側も Validation 部分は
  "still under active update and discussion with the TEE community" として流動的と明記。
  推測でアドレスを置かず、`BASE_VALIDATION_REGISTRY = undefined` として未採取であることをコードに残した。
- Arc の Reputation アドレスは README の testnet 共通 vanity（`0x8004B663…`）と一致し、
  既存コードの値が独立に裏づけられた。
- **UNVERIFIED:** いずれのアドレスもコード存在（`eth_getCode`）は未確認。RPC への egress が遮断されているため。

### M0-3. リポジトリ側の採取（file:line）

| 項目 | 場所 |
|---|---|
| Circle DCW による署名・送信（汎用） | `src/erc8004/arc-tx.ts:53` `submitContractExecution` |
| identity 登録時の送信経路 | `src/erc8004/arc-executor.ts` |
| validator ウォレットの定義 | `src/erc8004/arc-tx.ts:40` `getValidatorWalletId`（env `CIRCLE_ARC_VALIDATOR_WALLET_ID`） |
| validator アドレス | `src/erc8004/arc-tx.ts:46` `getValidatorAddress`（env `ARC_VALIDATOR_ADDRESS`） |
| 鍵の保管の現状 | Circle DCW 側に保持。リポジトリには **walletId と address のみ**（秘密鍵・entity secret はコード・ログ・記録に入れていない） |
| 日次判断レコード | `src/store/decision-store.ts`（`trade_agent_daily:{agentId}`） |
| dated catalyst の判定レコード | `src/osd/catalyst-store.ts`（`status: pending/hit/partial/miss/na`） |
| reputation の score 計算 | `src/erc8004/arc-reputation.ts:43` `computeReputationScore` / `:79` `computeDecisionActivityScore` |

### M0-4. 書き込み先チェーンの選定

**選定: Arc Testnet（reputation・validation とも）。理由:**

1. **Validation は Arc しか選べない。** Base の ValidationRegistry は未公開（M0-2）。
   reputation と validation を別チェーンに分けると、第三者が突き合わせる際の参照が割れるため、
   両方を同じチェーンに揃える。
2. **予算。** 通算上限 $1.00 に対し Base mainnet は実 gas を消費する。Arc Testnet の native token は
   faucet 配布で市場価格を持たないため、上限内に確実に収まる。
3. **既存の配線。** Circle DCW の TEST 認証・owner/validator ウォレットが Arc 向けに用意済みで、
   identity 登録（agentId 845265）も Arc で通っている実績がある。

**留意点（記録として残す）:** 日次判断は Base の agentId 55560 に紐づくが、reputation は Arc の
agentId 845265 に対して書かれる。feedback の off-chain JSON に `baseAgentId` を含めて両者を対応づけている
（`src/scripts/arc-record-reputation.ts`）。Base の ReputationRegistry へ移す場合は
`BASE_REPUTATION_REGISTRY` と mainnet 用のレート指定（下記）が必要。

---

## M1. 記録スキーマ

**制約の反映:**

- 追記専用。`registry-run-log.ts` は追記 API のみで、更新・削除 API を提供しない。
- 日次判断の既存規律は変更なし。取れなかったシグナルは寄与ゼロのまま、判断ロジック・寄与計算には触れていない。
- オンチェーンには検証に要る最小限のみ。判断内容の全文はチェーンに載せない。

### reputation（記録の単位）

**単位: 期間集計 1 件**（都度の日次判断ごとではなく、その時点の実績を 1 feedback にまとめる）。
理由は gas を通算上限に収めること、および score が「実績の集計値」であること。

| 置き場所 | 内容 |
|---|---|
| オンチェーン | `agentId`, `value`=score(0-100 整数), `valueDecimals`=0, `tag1`=score の出所, `feedbackHash`=根拠 JSON の keccak256 |
| オフチェーン（根拠 JSON、hash のみ紐づけ） | 算出式、判定内訳（hit/partial/miss）、対象 catalyst の id、または Mode A の日次判断リスト |

score の出所は 2 系統あり、`tag1` で区別する（捏造しない規律）:

1. `catalyst-accuracy` — 判定済み（hit/partial/miss）がある場合。`round(mean(hit=1,partial=0.5,miss=0)*100)`
2. `mode-a-daily-decision` — 当否がまだ無い期間の代替。`round(mean(|decision.score|)*100)`。
   **これは的中率ではなく判断の確信度平均**であり、根拠 JSON にその旨を明記している。
3. どちらも無ければ **記録しない**（`skipped_no_data`）。

### validation（dated catalyst の事後判定）

第三者が「事前に固定した予測」と「期日の判定結果」を追えるようにする:

| 段階 | オンチェーン | 対応づけ |
|---|---|---|
| request（owner） | `validatorAddress`, `agentId`, `requestURI`, `requestHash` | `requestHash` = **判定前に固定した予測 JSON** の keccak256 |
| response（validator） | `requestHash`, `response`(0-100), `responseURI`, `responseHash`, `tag` | 同じ `requestHash` を参照。`responseHash` = 判定結果 JSON の keccak256 |

`requestHash` を予測 JSON のハッシュにすることで、後から予測内容を差し替えられない
（差し替えると hash が変わり、チェーン上の request と一致しなくなる）。

---

## M2. 実装

| ファイル | 役割 |
|---|---|
| `src/erc8004/gas-budget.ts` | 予算の強制（1tx $0.10 / 通算 $1.00）。USD 換算。レート未指定の mainnet は失敗させる |
| `src/erc8004/registry-run-log.ts` | 実行記録の追記専用ストア + gas 通算額の永続化 |
| `src/erc8004/guarded-execute.ts` | 予算チェック → 送信 → gas 実額採取 → 記録、の共通経路 |
| `src/erc8004/arc-reputation.ts` | `giveFeedback`（validator のみ）。guardedExecute 経由に変更 |
| `src/erc8004/arc-validation.ts` | `validationRequest`(owner) / `validationResponse`(validator)。response 0-100 を送信前に検証 |
| `src/erc8004/contract.ts` | Base の Reputation アドレスを追記。Validation は未採取として `undefined` |
| `src/__tests__/erc8004-gas-budget.test.ts` | 予算ロジック・response 範囲の単体テスト（9 件） |

**予算の強制方法:**

- 送信前は「保守的な天井」で判定する。実チェーンの `eth_gasPrice` × `GAS_CEILING_UNITS`(既定 500,000) を
  見積もりとし、1tx 上限・通算上限のどちらかを超えるなら **送信せず** `skipped_budget` を記録して throw。
  Circle DCW が組む calldata を自前で再現して `eth_estimateGas` を引くと実際の送信内容と乖離しうるため、
  ガードとしては過大評価側に倒している。
- 送信後は receipt の `gasUsed × effectiveGasPrice` で **実額**を出し、通算に加算して記録。
  receipt に必要フィールドが無ければ **推測で埋めず throw**（gas 実額を記録できないことを隠さない）。
- 上限の引き上げは人間の判断。env `ERC8004_GAS_TX_CAP_USD` / `ERC8004_GAS_TOTAL_CAP_USD` の明示指定でのみ変わる。

**UNVERIFIED 一覧（ライブ未検証。コードにも同名ラベルを埋め込み、実行記録の `unverified` に残る）**

| ラベル | 内容 |
|---|---|
| `giveFeedback-live-unverified` | `giveFeedback` の実送信と revert 分岐（Self-feedback not allowed 等）が実チェーン未検証 |
| `validationRequest-live-unverified` | `validationRequest` の実送信と `"Not authorized"` 分岐が未検証 |
| `validationResponse-live-unverified` | `validationResponse` の実送信と `"not validator"` / `"resp>100"` 分岐が未検証 |
| Base アドレスのコード存在 | `BASE_REPUTATION_REGISTRY` の `eth_getCode` 未確認（`contract.ts` のコメントに明記） |
| gas 実額 | Arc の `effectiveGasPrice` の実値は未観測。gas 実額の列は環境B消化後に埋まる |

**触っていないもの:** AA の判断ループ・寄与計算・売買基準・日次判断の記録規律。

---

## M3. 実行記録の形

`data/arc/registry-run.jsonl`（追記専用）と Upstash `erc8004_registry_run` に同じ行を残す。
1 行 1 エントリ:

| フィールド | 内容 |
|---|---|
| `at` | 日時（ISO8601） |
| `chain` | チェーン |
| `registry` / `registry_address` | レジストリ名とアドレス |
| `fn` | 呼んだ関数シグネチャ |
| `subject` | 対象エントリの識別子（agentId / requestHash / feedbackHash） |
| `result` | `success` / `failed` / `skipped_budget` / `skipped_no_data` |
| `tx_hash` | txハッシュ |
| `gas_units` / `gas_price_wei` / `gas_cost_usd` | gas 実額 |
| `cumulative_usd` | その時点の通算 gas |
| `error` | 失敗理由・想定外レスポンス（そのまま残す） |
| `unverified` | 通過したライブ未検証分岐のラベル |

秘密（API key / entity secret / 秘密鍵）は記録しない。walletId・アドレスは秘密ではないため記録する。

### 実行記録

以下は `data/arc/registry-run.jsonl` から生成する（手書きしない）:

```bash
npm run build && node dist/scripts/erc8004-run-report.js --write
```

<!-- BEGIN:RUN-RECORD -->
| 日時 | チェーン | レジストリ | 関数 | 対象 | tx | gas実額 | 結果 |
|---|---|---|---|---|---|---|---|
| 2026-08-18 | ARC-TESTNET | ReputationRegistry | giveFeedback | `agentId=845265` / `feedbackHash=0x1ff5506d…a320e272` | [`0x903015ff…`](https://testnet.arcscan.app/tx/0x903015ffcb835aa774daec4d8ab93fe016f71e957b8695ca5ffa5f78b94bc14e) | $0.000000 | success |
| 2026-08-18 | ARC-TESTNET | ValidationRegistry | validationRequest | `agentId=845265` / `requestHash=0x5ac85dca…f776561b` | [`0xa2ba4a09…`](https://testnet.arcscan.app/tx/0xa2ba4a09bcc2ff1ba1907853e160f4776152249c1164ecc8490213f277366abc) | $0.000000 | success |
| 2026-08-18 | ARC-TESTNET | ValidationRegistry | validationResponse | `requestHash=0x5ac85dca…f776561b` / `response=100` | [`0xce0a6375…`](https://testnet.arcscan.app/tx/0xce0a6375fe906574568ff506932670e6359088d8ce80cd57ed19d870fe76e2e2) | $0.000000 | success |

通算 gas: **$0.000000** / 上限 $1.00（success 3 件 / それ以外 0 件）

**この `$0.000000` は誤解を招く表示であり、ガードの欠陥である（未修正）。**

`resolveUsdPerNative("ARC-TESTNET")` を 0 と決め打ちしているため 0 と表示されるが、
arcscan 上では実際に **0.028217 USDC** が動いている（Arc は gas を USDC で支払う）。
結果として:

- **通算上限 $1.00 が一度も効かない。** すべての tx が $0 と評価されるため、
  `checkBudget` は永遠に許可を返す。予算ガードは Arc 上で**実質的に無効**。
- 記録が「消費ゼロ」に見え、実際の消費を隠している（「失敗・実態を隠さない」規律に反する）。

gas 単位・gasPrice の実値自体は `data/arc/registry-run.jsonl` の
`gas_units` / `gas_price_wei` に残っているため、事後の復元は可能。

**修正方針:** Arc の gas 通貨は USDC なので、名目 1:1（1 native = $1）で評価するのが正しい。
テストネット USDC に市場価値が無いことと、**予算ガードの単位として正しいこと**は別問題。
名目 1:1 にすれば 0.028217/tx となり、$0.10/tx 上限は効き、$1.00 通算は約 35 tx で当たる。
<!-- END:RUN-RECORD -->

---

## M4. 環境Bの消化状況

**消化済み（2026-08-18、Railway 上で実行）。**

**訂正:** 当初この節を「最初の 1 件が着地した」と書いたが誤り。
**2026-07-06 に同じ 3 点セットが実行済み**（rep `0x676940…` / req `0x281ac8…` / resp `0xe859eb…`、score 30）で、
今回は 2 回目にあたる。リポジトリ側の裏づけ: `1bac930`（2026-07-04, Reputation+Validation 追加）、
`2346f5e`（2026-07-06, score 源を trade_agent_daily に対応）。
今回の `feedbackIndex=2` は上書きではなく積み上がった結果で、これ自体が append-only の実証になっている
（ただし index が 0 起点か 1 起点かはコントラクト実装を未確認のため、
「同一 validator から過去に 1 件以上の書き込みがある」ことまでが確実に言える範囲）。

- [x] ReputationRegistry への書き込み — `giveFeedback` 成功、`feedbackIndex=2`（**2 回目**）
- [x] ValidationRegistry への 1 往復 — `validationRequest` → `validationResponse(100)` 成功（**2 回目**）

### score 30（7/6）→ 12（8/18）は精度低下ではない

算出式は **同一**。`computeDecisionActivityScore` = `round(mean(|decision.score|)*100)` は
`2346f5e`（2026-07-06）で導入され、HEAD まで**変更されていない**（`git diff 2346f5e..HEAD -- src/erc8004/arc-reputation.ts` に
式の差分なし）。したがって 30→12 の差は **対象期間と n の差**であり、
同じ `mode-a-daily-decision` 定義の上での母数変化（8/18 時点で n=65, BUY=14, SKIP=51）。

より重要な構造的問題として、**算出定義はレジストリに残らない**。オンチェーンに載るのは
`value`(=score) と `tag1` だけで、`catalyst-accuracy` に切り替われば
**同じ「score」という名前で別定義の数値**が同じ列に積まれる。
定義は off-chain の feedback JSON（`feedbackHash` で紐づく）にしか無く、
そのJSONは現状どこにも公開していない（`feedbackURI` は空）。
→ 第三者が score の意味を復元できない。**`feedbackURI` に定義を公開することが次の課題。**
- [x] validator ウォレットからの送信が通ること（`"Self-feedback not allowed"` で弾かれなかった＝
      validator は owner でも approved でもない、と実チェーンで裏づけられた）
- [x] owner からの `validationRequest` が通ること（`"Not authorized"` で弾かれなかった）
- [ ] レジストリアドレスの `eth_getCode` による明示確認（下記のとおり実質的には裏づけ済み）
- [ ] 判定済み dated catalyst を対象にした validation（今回は identity-liveness を対象にした）
- [ ] 実測 gas を踏まえた運用組み込み（日次か判定日ごとか）の決定

### 今回の実行で解消された UNVERIFIED

| ラベル | 状態 |
|---|---|
| `giveFeedback-live-unverified` | **解消**。tx 成功かつ `NewFeedback` から `feedbackIndex=2` を抽出できた（event が出た＝関数が通った） |
| `validationRequest-live-unverified` | **解消**。tx 成功 |
| `validationResponse-live-unverified` | **解消**。tx 成功。`response=100` が `require(response <= 100)` を通った |
| Arc レジストリアドレス | **実質解消**。当該アドレス宛の呼び出しが 3 件とも成功しているため、コード存在・稼働は裏づけられた |
| Base `0x8004BAa1…` のコード存在 | **未解消**。Base へは書いていない（下記「Base を対象にしない理由」） |

### 残っている確認

`giveFeedback` は `NewFeedback` event を抽出できたため関数の実行そのものが確認できている。
`validationRequest` / `validationResponse` は event 抽出をしていないため、
**arcscan で 2 tx が Success（revert していない）ことを目視確認するまで「記録できた」と断定しない。**

なお実装の穴として、`getGasActual` が `receipt.status` を見ておらず、revert した tx でも
`success` として記録されうる状態だった。今回の実行後に status チェックを追加済み
（成功でなければ throw する）。

### Base を対象にしない理由（記録）

1. Base には **ValidationRegistry が公開されていない**（M0-2）。Reputation だけ Base に置くと
   validation と参照先が割れる。
2. Arc Testnet の gas は faucet トークンで実質 $0。通算上限 $1.00 を消費しない。
3. Circle のグラントを想定する場合、Arc は Circle 自身のチェーンであり、
   identity（845265）・reputation・validation が同一チェーンに揃う方が第三者が追いやすい。

Base の ReputationRegistry へ広げる場合に必要なもの: `BASE_REPUTATION_REGISTRY` の
`eth_getCode` 確認、Base の owner/validator ウォレット、および
`ERC8004_GAS_USD_PER_NATIVE`（ETH の USD レート）の明示設定
（未設定なら見積もれないためコードが書き込みを拒否する）。

### 環境Bでの実行手順

Railway（env が揃っている環境）で:

```bash
npm run build
node dist/scripts/arc-record-reputation.js   # ReputationRegistry へ 1 件
node dist/scripts/arc-run-validation.js      # ValidationRegistry へ 1 往復
```

事前に確認すること:

- validator ウォレットが対象 agent の **owner でも approved/operator でもない**こと
  （該当すると `"Self-feedback not allowed"` で revert する）
- validator ウォレットに Arc Testnet の gas 残高があること（faucet: https://faucet.circle.com）
- Base mainnet へ書く場合は `ERC8004_GAS_USD_PER_NATIVE`（ETH の USD レート）を明示設定すること。
  未設定なら予算を見積もれないため、コードが書き込みを拒否する

実行後、`data/arc/registry-run.jsonl` の内容を上の「実行記録」表に反映し、
arcscan（https://testnet.arcscan.app）で各 tx が Success であることを確認するまで
「記録できた」としない。
