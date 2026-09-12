/**
 * EDINET 実財務スキーマ(osd #51)のパースと単位換算。区分A: フィールド名に対して完結。
 * 実値は区分B(有料 inspect)で確認するが、パースの規律(fail loud・捏造しない・単位整合)は
 * ここで固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEdinetFinancials,
  jpyToMillions,
  EDINET_FINANCIAL_FIELDS,
  EDINET_SOURCE,
} from "../edinet/schema";

test("financials_available:true — 生JPY をそのまま読む(捏造しない)", () => {
  const body = {
    sales: 203748000000,
    operating_income: 10253000000,
    net_income: 7100000000,
    period: "2025-04-01/2026-03-31",
    doc_id: "S100ABCD",
    submit_datetime: "2026-06-20T15:00:00+09:00",
    financials_available: true,
    source: EDINET_SOURCE,
  };
  const f = parseEdinetFinancials(body);
  assert.equal(f.available, true);
  assert.equal(f.salesJpy, 203748000000);
  assert.equal(f.operatingIncomeJpy, 10253000000);
  assert.equal(f.netIncomeJpy, 7100000000);
  assert.equal(f.period, "2025-04-01/2026-03-31");
  assert.equal(f.docId, "S100ABCD");
  assert.equal(f.source, EDINET_SOURCE);
});

test("生JPY → 百万円(÷1e6)。catalyst の百万円表記と桁が揃う", () => {
  // 東京エレクトロンデバイス売上: EDINET 生JPY 203,748,000,000 → 203,748 百万円
  // (catalyst 側の revenue 203748 と一致)
  assert.equal(jpyToMillions(203748000000), 203748);
  assert.equal(jpyToMillions(10253000000), 10253);
  assert.equal(jpyToMillions(null), null);
  assert.equal(jpyToMillions(undefined), null);
  assert.equal(jpyToMillions(Number.NaN), null);
});

test("financials_available:false — 財務は null(空を財務に見せない)", () => {
  const f = parseEdinetFinancials({
    sales: null, operating_income: null, net_income: null,
    doc_id: "S100XXXX", period: "2025", financials_available: false,
  });
  assert.equal(f.available, false);
  assert.equal(f.salesJpy, null);
  assert.equal(f.operatingIncomeJpy, null);
  assert.equal(f.docId, "S100XXXX", "書類は特定できている");
});

test("financials_available が無いレスポンスは throw(旧仕様/想定外を握りつぶさない)", () => {
  // type=2・14日窓の旧レスポンス(window_days/count)を想定
  assert.throws(
    () => parseEdinetFinancials({ window_days: 14, count: 0, cache: "weekly", code: "2760" }),
    /financials_available/
  );
  assert.throws(() => parseEdinetFinancials(null), /not an object/);
});

test("財務値が数値でなければ null(推測補完しない)", () => {
  const f = parseEdinetFinancials({ sales: "N/A", operating_income: {}, net_income: null, financials_available: true });
  assert.equal(f.salesJpy, null);
  assert.equal(f.operatingIncomeJpy, null);
});

test("スキーマ定数は単一定義(UI・sweep・消費側が参照)", () => {
  assert.deepEqual(EDINET_FINANCIAL_FIELDS, [
    "sales", "operating_income", "net_income", "period",
    "doc_id", "submit_datetime", "financials_available", "source",
  ]);
});
