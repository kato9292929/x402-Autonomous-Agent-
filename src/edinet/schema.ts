/**
 * osd `/api/edinet/{code}` の実財務スキーマ（osd #51）。UI・sweep・消費側が同じ定義を
 * 参照する単一の真実源。値そのものは区分B(Railway の有料 inspect)で確認するが、フィールド
 * 名は確定なので、ここに固定して区分A の実装を完結させる。
 *
 * 単位の規律: sales/operating_income/net_income は「生JPY」。表示は百万円に統一するので、
 * 消費側は必ず jpyToMillions() を通す(÷1e6)。catalyst 財務欄は既に百万円表記なので、そちらは
 * 換算せずそのまま百万円として扱う。単位ラベル(百万円)を必ず併記し、桁ズレを防ぐ。
 */

export const EDINET_SOURCE = "出典：金融庁 EDINET";
export const EDINET_DISPLAY_UNIT = "百万円";

/** 財務レスポンスのフィールド名（単一定義）。 */
export const EDINET_FINANCIAL_FIELDS = [
  "sales",
  "operating_income",
  "net_income",
  "period",
  "doc_id",
  "submit_datetime",
  "financials_available",
  "source",
] as const;

/** osd 有料レスポンスの生スキーマ。 */
export interface EdinetResponse {
  /** 当期・連結・生JPY／取得不可なら null。 */
  sales: number | null;
  operating_income: number | null;
  net_income: number | null;
  period?: string;
  doc_id?: string;
  submit_datetime?: string;
  /** true=財務抽出済み ／ false=書類は特定できたが財務未取得。 */
  financials_available: boolean;
  source?: string;
}

/** 生JPY → 百万円(表示用)。null/非数はそのまま null。推測補完はしない。 */
export function jpyToMillions(rawJpy: number | null | undefined): number | null {
  if (rawJpy === null || rawJpy === undefined) return null;
  if (typeof rawJpy !== "number" || !Number.isFinite(rawJpy)) return null;
  return Math.round(rawJpy / 1e6);
}

export interface EdinetFinancials {
  available: boolean;
  salesJpy: number | null;
  operatingIncomeJpy: number | null;
  netIncomeJpy: number | null;
  period?: string;
  docId?: string;
  submitDatetime?: string;
  source: string;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v === null || v === undefined) return null;
  // 文字列数値も許容するが、それ以外は null(捏造しない)。
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * osd の EDINET レスポンスを解釈する。
 *
 * fail loud: `financials_available` が無いレスポンスは旧仕様/想定外なので握りつぶさず throw する
 * (禁止事項: フォールバックで隠さない)。値は返ってきたものだけを読み、推測補完しない。
 */
export function parseEdinetFinancials(body: unknown): EdinetFinancials {
  if (!body || typeof body !== "object") {
    throw new Error("EDINET response is not an object");
  }
  const o = body as Record<string, unknown>;
  if (!("financials_available" in o)) {
    throw new Error(
      "EDINET response is missing `financials_available` — 旧仕様(type=2/14日窓)か想定外レスポンス。" +
        "区分B の有料 inspect で実レスポンスを確認すること。"
    );
  }
  const available = o.financials_available === true;
  return {
    available,
    // financials_available:false のときは財務を出さない(空を財務に見せない)。
    salesJpy: available ? asNum(o.sales) : null,
    operatingIncomeJpy: available ? asNum(o.operating_income) : null,
    netIncomeJpy: available ? asNum(o.net_income) : null,
    period: typeof o.period === "string" ? o.period : undefined,
    docId: typeof o.doc_id === "string" ? o.doc_id : undefined,
    submitDatetime: typeof o.submit_datetime === "string" ? o.submit_datetime : undefined,
    source: typeof o.source === "string" ? o.source : EDINET_SOURCE,
  };
}
