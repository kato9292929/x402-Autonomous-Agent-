/**
 * What osd `/api/edinet/{code}` returns, and how a paid answer is judged.
 *
 * The endpoint serves one company's latest EDINET disclosure as metadata:
 * filer_name, doc_id, doc_type_code, doc_description, submit_datetime and the
 * accounting period. Headline figures (sales / operating_income / net_income)
 * are not served: osd paused that extraction for reliability, and they come
 * back null with financials_available:false (osd's own descriptor at
 * GET /api/edinet and its 402 description, read 2026-11-13). Nothing here
 * expects or displays financial figures.
 *
 * A paid answer has content when it names a document: doc_id, filer_name and
 * submit_datetime are all present. Anything less is counted as missing.
 */
import type { ContentCheck } from "../content-check";

export const EDINET_SOURCE = "出典：金融庁 EDINET";

/** The paid route and what one call buys, for the card and the summary. */
export const EDINET_ENDPOINT = "/api/edinet/{code}";
export const EDINET_UNIT = "1社の最新の開示書類メタデータ(提出者・書類ID・書類種別・提出日時・会計期間)";

/** Fields a paid answer must carry to count as content. */
export const EDINET_REQUIRED_FIELDS = ["doc_id", "filer_name", "submit_datetime"] as const;

export interface EdinetMetadata {
  filerName?: string;
  docId?: string;
  docTypeCode?: string;
  docDescription?: string;
  submitDatetime?: string;
  /** Accounting period, as the seller writes it (start–end or a label). */
  period?: string;
  /** True only if osd ever serves figures again; recorded, not relied on. */
  financialsAvailable?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

function periodOf(o: Record<string, unknown>): string | undefined {
  const p = o.period;
  if (typeof p === "string") return str(p);
  if (p && typeof p === "object") {
    const q = p as Record<string, unknown>;
    const s = str(q.start) ?? str(q.period_start), e = str(q.end) ?? str(q.period_end);
    if (s || e) return `${s ?? "?"}〜${e ?? "?"}`;
  }
  const s = str(o.period_start), e = str(o.period_end);
  return s || e ? `${s ?? "?"}〜${e ?? "?"}` : undefined;
}

/** Read the metadata out of a paid body. Absent fields stay absent; nothing is filled in. */
export function parseEdinetMetadata(body: unknown): EdinetMetadata {
  if (!body || typeof body !== "object") return {};
  const o = body as Record<string, unknown>;
  return {
    filerName: str(o.filer_name),
    docId: str(o.doc_id),
    docTypeCode: str(o.doc_type_code) ?? (typeof o.doc_type_code === "number" ? String(o.doc_type_code) : undefined),
    docDescription: str(o.doc_description),
    submitDatetime: str(o.submit_datetime),
    period: periodOf(o),
    financialsAvailable: typeof o.financials_available === "boolean" ? o.financials_available : undefined,
  };
}

/** Whether a paid answer names a document. */
export function checkEdinetBody(body: unknown): ContentCheck {
  if (!body || typeof body !== "object") return { ok: false, reason: "本文が JSON でない・空" };
  const o = body as Record<string, unknown>;
  const missing = EDINET_REQUIRED_FIELDS.filter((k) => !str(o[k]));
  if (missing.length === 0) return { ok: true };
  if (missing.length === EDINET_REQUIRED_FIELDS.length) {
    const why = str(o.error) ?? str(o.message) ?? str(o.reason);
    return { ok: false, reason: `書類が特定されていない${why ? `: ${why.slice(0, 80)}` : ""}` };
  }
  return { ok: false, reason: `欠けた項目: ${missing.join(", ")}` };
}
