/**
 * osd /api/edinet/{code} returns disclosure metadata only (financials paused,
 * null with financials_available:false). A paid answer counts as content when
 * it names a document.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEdinetBody, parseEdinetMetadata, EDINET_REQUIRED_FIELDS } from "../edinet/schema";
import { contentCounts } from "../jobs/catalyst-sweep";

// The shape osd documents at GET /api/edinet (read 2026-11-13).
const meta = {
  filer_name: "トヨタ自動車株式会社",
  doc_id: "S100XXXX",
  doc_type_code: "140",
  doc_description: "四半期報告書－第122期第2四半期",
  submit_datetime: "2026-11-10 15:00",
  period: { start: "2026-07-01", end: "2026-09-30" },
  sales: null,
  operating_income: null,
  net_income: null,
  financials_available: false,
  source: "出典：金融庁 EDINET",
};

test("a metadata answer is content; its null figures are not required", () => {
  assert.deepEqual(checkEdinetBody(meta), { ok: true });
  const m = parseEdinetMetadata(meta);
  assert.equal(m.filerName, "トヨタ自動車株式会社");
  assert.equal(m.docDescription, "四半期報告書－第122期第2四半期");
  assert.equal(m.period, "2026-07-01〜2026-09-30");
  assert.equal(m.financialsAvailable, false);
});

test("an answer without a document is missing, with what is missing", () => {
  assert.match(checkEdinetBody({ code: "9999", doc_id: null, filer_name: null, submit_datetime: null }).reason!, /書類が特定されていない/);
  assert.match(checkEdinetBody({ code: "9999", error: "no report in window" }).reason!, /no report in window/);
  assert.deepEqual(checkEdinetBody({ ...meta, submit_datetime: "" }), { ok: false, reason: "欠けた項目: submit_datetime" });
  assert.equal(checkEdinetBody(null).ok, false);
  assert.deepEqual([...EDINET_REQUIRED_FIELDS], ["doc_id", "filer_name", "submit_datetime"]);
});

test("nothing is filled in: absent fields stay absent", () => {
  assert.deepEqual(parseEdinetMetadata({ doc_id: "S1" }), {
    filerName: undefined, docId: "S1", docTypeCode: undefined, docDescription: undefined,
    submitDatetime: undefined, period: undefined, financialsAvailable: undefined,
  });
});

test("sweep counts: content, missing by reason, and answers carrying figures", () => {
  const paid = (ok: boolean, reason?: string, fin?: boolean) => ({
    at: "x", ticker: "1", outcome: "paid" as const, latencyMs: 1,
    content: ok ? { ok } : { ok, reason }, meta: { financialsAvailable: fin },
  });
  const c = contentCounts([
    paid(true, undefined, false), paid(true, undefined, false),
    paid(false, "書類が特定されていない: x"), paid(false, "欠けた項目: doc_id"),
    { at: "x", ticker: "2", outcome: "skipped", latencyMs: 0 },
  ]);
  assert.deepEqual(c, { ok: 2, missing: 2, financials: 0, reasons: { 書類が特定されていない: 1, 欠けた項目: 1 } });
});
