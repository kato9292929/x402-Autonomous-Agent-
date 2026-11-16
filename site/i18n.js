/**
 * Japanese / English for aa.x402jp.com.
 *
 * Language: ?lang=ja|en, else the last choice (localStorage), else the
 * browser's language (Japanese for ja-*, English otherwise). The toggle in the
 * nav stores the choice and reloads.
 *
 *   L('日本語', 'English')  picks the string for the current language.
 *   tr(text)               English for the Japanese the server writes into
 *                          records (reasons, labels); text it does not know is
 *                          returned as is, so nothing is lost.
 *   applyStatic()          fills elements carrying data-ja / data-en (and
 *                          data-ja-title / data-en-title) in index.html.
 */
const KEY = 'aa-lang';

function detect() {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'ja' || q === 'en') {
      try { localStorage.setItem(KEY, q); } catch { /* private mode */ }
      return q;
    }
  } catch { /* no location */ }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  return /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en';
}

export const LANG = detect();
export const L = (ja, en) => (LANG === 'ja' ? ja : en);
/** Locale for numbers and dates. */
export const LOCALE = LANG === 'ja' ? 'ja-JP' : 'en-US';

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked */ }
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.toString());
}

export function applyStatic(root = document) {
  document.documentElement.lang = LANG;
  root.querySelectorAll('[data-ja],[data-en]').forEach((el) => {
    const v = el.getAttribute(LANG === 'ja' ? 'data-ja' : 'data-en');
    if (v !== null) el.innerHTML = v;
  });
  root.querySelectorAll('[data-ja-title],[data-en-title]').forEach((el) => {
    const v = el.getAttribute(LANG === 'ja' ? 'data-ja-title' : 'data-en-title');
    if (v !== null) el.setAttribute('title', v);
  });
  root.querySelectorAll('[data-ja-aria],[data-en-aria]').forEach((el) => {
    const v = el.getAttribute(LANG === 'ja' ? 'data-ja-aria' : 'data-en-aria');
    if (v !== null) el.setAttribute('aria-label', v);
  });
}

/* ── Server-written Japanese → English ───────────────────────────────────
   Each entry is a whole-pattern rewrite of a template the server uses (see
   the source named in the comment). Order matters: longer, more specific
   templates first. */
const STAGES = {
  '準備(MXE・ウォレット)': 'setup (MXE / wallet)', 'RPC': 'RPC', '計算の投入': 'queueing',
  'コールバック待ち': 'waiting for callback', 'コールバック tx': 'callback tx',
  '結果の読み取り': 'reading the result', 'x402 の支払い': 'x402 payment', '停止中': 'paused',
};
const stage = (s) => STAGES[s] || s;

const RULES = [
  // fallback-cooldown.ts cooldownReason
  [/^cooldown: (\d+)日連続で劣化データ・中身なしのため購入停止中\(live復帰を確認中\)(?: — 直近: (.*))?$/s,
    (_, n, last) => `cooldown: ${n} days in a row of fallback or empty data — not bought daily (checking for recovery)${last ? ` — latest: ${tr(last)}` : ''}`],
  [/^cooldown: (\d+)日連続で劣化データのため購入停止中\(live復帰を確認中\)$/, (_, n) => `cooldown: ${n} days in a row of fallback data — not bought daily (checking for recovery)`],
  // spbuy/run.ts notCalled
  [/^cooldown: (\d+)日続けて中身の確認に外れた(?: — (.*))?$/s, (_, n, last) => `cooldown: failed the content checks ${n} days in a row${last ? ` — ${last}` : ''}`],
  [/^1日の予算 \$([\d.]+) に届くため今日は買わない$/, (_, n) => `would exceed the $${n} daily budget — not bought today`],
  // content-check.ts
  [/^tokens 0件\(total_scanned ([^)]*)\)(?::\s*(.*))?$/s, (_, n, w) => `0 tokens (total_scanned ${n})${w ? `: ${w}` : ''}`],
  [/^results 0件$/, () => '0 results'],
  [/^transfers 0件$/, () => '0 transfers'],
  [/^transfers の tx_hash が実在しない形\((.*)\)$/, (_, h) => `transfers carry a tx_hash that cannot exist (${h})`],
  [/^送った入力の繰り返しだけで中身が無い$/, () => 'only repeats the input we sent; no content'],
  [/^値の入った項目が無い$/, () => 'no field carries a value'],
  [/^本文が空$/, () => 'empty body'],
  [/^(\d{4}-\d{2}-\d{2}) から本文が同じ\(日付だけ更新\)$/, (_, d) => `same body since ${d} (only the date changes)`],
  // edinet/schema.ts
  [/^書類が特定されていない(?::\s*(.*))?$/s, (_, w) => `no document identified${w ? `: ${w}` : ''}`],
  [/^欠けた項目: (.*)$/, (_, f) => `missing fields: ${f}`],
  [/^欠けた項目$/, () => 'missing fields'],
  [/^本文が JSON でない・空$/, () => 'body is not JSON, or empty'],
  [/^中身の無い応答が (\d+) 件続いたため中断\(直近: (.*)\)$/s, (_, n, r) => `stopped after ${n} empty answers in a row (latest: ${tr(r)})`],
  [/^(\d+) 回連続エラーで中断$/, (_, n) => `stopped after ${n} errors in a row`],
  // mxe/breaker.ts
  [/^(\d+)日続けて「(.+?)」で失敗\((.*?)\): (.*)$/s, (_, n, s, d, e) => `failed at "${stage(s)}" ${n} days in a row (${d}): ${e}`],
  // modes/modeA.ts
  [/^Smart Money Screener 購入停止\((.*?)\): (.*)$/s, (_, d, r) => `Smart Money Screener not bought since ${d}: ${tr(r)}`],
  // config.ts disabled reasons (2026-11-15)
  [/^10月末から毎日 dataMode=fallback\(クールダウン中だった\)$/, () => 'dataMode=fallback every day since late October (it was in cooldown)'],
  [/^11\/4 から毎日 results 0件$/, () => '0 results every day since 11/4'],
  [/^11\/4 から毎日 tokens 0件・total_scanned 0\(Nansen が base・solana を扱っていないという警告\)$/, () => '0 tokens / total_scanned 0 every day since 11/4 (warning: Nansen does not cover base or solana)'],
  [/^11\/4 から summary_ja が毎日同じ文面$/, () => 'the same summary_ja text every day since 11/4'],
  [/^transfers の tx_hash が実在しない値\(0xabc123\)$/, () => 'transfers carry a tx_hash that does not exist (0xabc123)'],
  // probe/targets.ts suspended reasons, external-probe.ts
  [/^オリジン全体が 502\(`\/`・`\/\.well-known\/x402`・有料ルートすべて\)$/, () => 'the whole origin answers 502 (/, /.well-known/x402 and every paid route)'],
  [/^支払い提示後に HTTP 500\(無課金の 402 は正常\)。売り手側の障害$/, () => 'HTTP 500 after payment is presented (the unpaid 402 is fine); a seller-side failure'],
  [/^停止中\((.*?)\): (.*)$/s, (_, d, r) => `suspended (${d}): ${tr(r)}`],
  [/^予算で拒否\((.*?)\): (.*)$/s, (_, c, r) => `refused by budget (${c}): ${r}`],
  [/^執行系ルート — 読み取り専用の運用のため呼ばない$/, () => 'execution route — not called (read-only operation)'],
  [/^probe ウォレットが対応しないチェーンのみ提示された \(offered: (.*)\)$/, (_, o) => `only chains the probe wallet cannot pay were offered (offered: ${o})`],
  [/^PAYMENT-RESPONSE を読めない$/, () => 'PAYMENT-RESPONSE unreadable'],
  // spbuy/run.ts preflight
  [/^支払いなしの要求が失敗: (.*)$/s, (_, e) => `unpaid request failed: ${e}`],
  [/^HTTP (\d+) on (\w+), not 402 — 払わない$/, (_, s, m) => `HTTP ${s} on ${m}, not 402 — not paid`],
  [/^402 を読めない$/, () => '402 unreadable'],
  [/^受取先が自社\(payTo\)$/, () => 'payTo is our own'],
  [/^払えるネットワークの提示がない$/, () => 'no network we can pay was offered'],
  [/^提示額 \$([\d.]+) が上限 \$([\d.]+) を超える$/, (_, a, c) => `quoted $${a} exceeds the $${c} cap`],
  [/^dry run: 402 を確認、払っていない$/, () => 'dry run: 402 confirmed, not paid'],
  [/^支払いクライアントなし$/, () => 'no paying client'],
  // EDINET unit (edinet/schema.ts EDINET_UNIT)
  [/^1社の最新の開示書類メタデータ\(提出者・書類ID・書類種別・提出日時・会計期間\)$/, () => "one company's latest disclosure metadata (filer, document id, document type, submission time, accounting period)"],
];

export function tr(text) {
  if (LANG === 'ja' || text == null) return text;
  const s = String(text);
  for (const [re, f] of RULES) {
    const m = s.match(re);
    if (m) return f(...m);
  }
  return s;
}

/** English names of the MXE functions (mxe/record.ts MXE_FUNCTION_LABELS). */
export const MXE_FN_EN = {
  1: 'Sealed reservation-price matching',
  2: 'Sealed-quote RFQ',
  3: 'Seller score without revealing raters',
  4: 'Group purchase without revealing participants',
  5: 'Endpoint search with a hidden intent',
};
export const stageLabel = stage;

/** English for the failure stages, by key (mxe/stage.ts). */
export const STAGE_EN = {
  setup: 'setup (MXE / wallet)', rpc: 'RPC', queue: 'queueing', callback_wait: 'waiting for callback',
  callback_tx: 'callback tx', read_result: 'reading the result', payment: 'x402 payment', paused: 'paused',
};

/** English for Seller Probe's verdicts (spbuy/run.ts VERDICT_LABELS). */
export const VERDICT_EN = {
  as_described: 'Delivered as described',
  not_as_described: 'Delivered, not as described',
  input_mismatch: 'No 402 without payment (not paid)',
  paid_then_rejected: 'Paid, then the request was refused',
  paid_not_delivered: 'Paid, nothing delivered',
  not_settled: 'No transfer, nothing delivered',
  not_bought: 'Not bought',
};
