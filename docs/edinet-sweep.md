# 週次 EDINET sweep（買い手・Solana mainnet）

osd の `GET /api/edinet`（一覧）と `GET /api/edinet/{code}`（本体・402課金）を、AA 買い手が
週1回ループで叩き、1件 **0.001 USDC = 1000 units** を Solana で払う。catalyst と同じ「毎週 N 件
per-call 決済している」証跡。データ判断はしない（`executed` に触れない）。

## catalyst と同じエンジン

catalyst と EDINET は**同じエンジンの2つの surface 設定**（`src/paycall/surface.ts`）。
安全弁（Solana / 公式USDC mint / ちょうど price / exact）・Circle署名・自動ロールバック・reset・
週次予算は**1本の共有コード**。surface が変えるのは：

| | catalyst | edinet |
|---|---|---|
| base path | `/api/catalyst` | `/api/edinet` |
| 状態キー | `catalyst_autopilot:state` | `edinet_autopilot:state` |
| spend namespace | `catalyst` | `edinet` |
| CSV | `data/catalyst/…` | `data/edinet/…` |
| cron | 水 09:00 JST | 木 09:00 JST |
| 価格/mint/cap | env `CATALYST_*`（既定1000/公式/$0.50） | env `EDINET_*`（同既定） |

分離キーなので、片方が live/smoking でももう片方に影響しない（テストで固定）。

## 手順（自走 / autopilot・推奨）

前提はもう揃っている（osd の /api/edinet は 1000 units 本番稼働、EDINET_API_KEY は osd Vercel、
AA の価格デフォルトも 1000）。catalyst で潰した dust/価格不一致は EDINET では起きない。

```
人が1回:
  1. Solana 決済レール有効（日次が動いていれば済。catalyst と同じ 7PVTo ウォレット共用）
  2. 専用 SOLANA_RPC_URL（catalyst と共有。設定済みなら追加不要）
  3. UPSTASH_REDIS_REST_*（冪等性の状態保存。設定済み）
  4. EDINET_AUTOPILOT=true

以降 AA が起動時に自走:
  run0(無課金・GET /api/edinet で一覧→サンプル402確認) → 払える402なら mainnet 1件 実課金
  → 実tx が返れば live → 週次sweep(木 09:00 JST)を自分でスケジュール
```

冪等性・自動ロールバック・stuck時の `npm run edinet:reset` は catalyst と同一の仕組み
（詳細は `docs/catalyst-sweep.md`）。手動は `npm run edinet:run0` / `npm run edinet:sweep`。

## EDINET は買い手側だけ

EDINET API 本体（EDINET_API_KEY で金融庁の開示書類を取る）は **osd（売り手）側**。AA は
`/api/edinet/{code}` を x402 で買うだけで、`EDINET_API_KEY` は持たない。対象コード一覧も
osd の `GET /api/edinet` から取得する（catalyst と同じく捏造しない）。
