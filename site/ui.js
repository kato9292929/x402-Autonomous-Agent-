/** Menu, endpoints overlay, and the live "latest run" card. */
import { L, tr, LOCALE, LANG, setLang, applyStatic, MXE_FN_EN, STAGE_EN, VERDICT_EN } from './i18n.js';

applyStatic();
document.getElementById('lang-toggle')?.addEventListener('click', () => setLang(LANG === 'ja' ? 'en' : 'ja'));

/* ── Endpoint catalog ──────────────────────────────────────────────────────
   Hosts are the x402jp.com custom domains. Prices and descriptions match the
   published catalog on x402jp.com/products.html. `daily` marks the endpoints
   this agent calls on its 06:00 JST schedule; `stopped` the ones it no longer
   buys (empty answers every day; config.ts `disabled`). */
const GROUPS = [
  {
    name: 'Japan Inflation Nowcall',
    host: 'jin.x402jp.com',
    note: L('決済は Solana USDC（x402 v2）。discovery は /.well-known/x402.json。', 'Settled in Solana USDC (x402 v2). Discovery: /.well-known/x402.json.'),
    eps: [
      { method: 'GET', path: '/api/jin/latest', free: true, daily: true, desc: L('最新観測日の指数（excl_promo / incl_promo・matched・base_date・coverage・passthrough_gap）。', 'Index for the latest observed day (excl_promo / incl_promo, matched, base_date, coverage, passthrough_gap).') },
      { method: 'GET', path: '/api/jin/series', price: '$0.01', desc: L('指数の時系列（from / to は任意）。', 'Index time series (from / to optional).') },
      { method: 'GET', path: '/api/jin/movers', price: '$0.02', daily: true, desc: L('その日動いた品目（特売タグ付き。date は任意）。', 'Items that moved that day, with promotion tags (date optional).') },
    ],
  },
  {
    name: 'Onchain Stock Data',
    host: 'osd.x402jp.com',
    note: L('決済は Base または Solana USDC（dual）。402が両方のチェーンを提示するので、クライアントがどちらかを選ぶ。discovery は /.well-known/x402.json。', 'Settled in Base or Solana USDC (dual). The 402 offers both chains and the client picks one. Discovery: /.well-known/x402.json.'),
    eps: [
      { method: 'GET', path: '/api/alpha/catalysts/physical-ai', free: true, desc: L('Physical-AI スコアボード（hit-rate・全86条件・記事別、機械可読 JSON）。', 'Physical-AI scoreboard (hit rate, all 86 conditions, per article; machine-readable JSON).') },
      { method: 'GET', path: '/api/alpha/portfolio/current', price: '$0.01', daily: true, desc: L('米ポートフォリオ 現在10銘柄（ticker / weight / thesis）。', 'US portfolio: current 10 holdings (ticker / weight / thesis).') },
      { method: 'GET', path: '/api/alpha/portfolio/scorecard', price: '$0.01', daily: true, desc: L('米 catalyst hit-rate ＋ SPY / QQQ 累積リターン。', 'US catalyst hit rate + cumulative return vs SPY / QQQ.') },
      { method: 'GET', path: '/api/alpha/jp/portfolio/current', price: '$0.01', daily: true, desc: L('日本ポートフォリオ 現在10銘柄。', 'Japan portfolio: current 10 holdings.') },
      { method: 'GET', path: '/api/alpha/jp/scorecard', price: '$0.01', daily: true, desc: L('日本 hit-rate（ベンチ指数なし）。', 'Japan hit rate (no benchmark index).') },
      { method: 'GET', path: '/api/alpha/jp/catalysts', price: '$0.01', daily: true, desc: L('日本 dated catalysts 一覧。', 'Japan dated catalysts.') },
      { method: 'POST', path: '/api/alpha/catalyst/submit', price: '$0.01', desc: L('外部 catalyst 投稿（→ id ＋ score_lookup）。', 'Submit an external catalyst (→ id + score_lookup).') },
      { method: 'GET', path: '/api/alpha/catalyst/:catalyst_id/score', price: '$0.01', desc: L('投稿 catalyst の Claude 判定（pending / hit / partial / miss / na）。', "Claude's verdict on a submitted catalyst (pending / hit / partial / miss / na).") },
    ],
  },
  {
    name: 'Intelligence',
    note: L('決済は Base USDC。', 'Settled in Base USDC.'),
    eps: [
      { method: 'GET', path: 'x402amd.vercel.app/api/macro/dashboard', price: '$0.30', stopped: true, desc: L('APACマクロ。金利・為替・フロー・リスク regime。', 'APAC macro: rates, FX, flows, risk regime.') },
      { method: 'GET', path: 'x402yi.vercel.app/api/yield/scan', price: '$0.20', daily: true, desc: L('DeFiの利回りスキャン。プール別のAPYとスマートマネー残高。', 'DeFi yield scan: APY and smart-money balance per pool.') },
      { method: 'POST', path: 'x402pi.vercel.app/api/portfolio/analyze', price: '$0.30', daily: true, desc: L('ウォレットアドレスを渡すとポートフォリオを分析。', 'Analyzes the portfolio of a wallet address.') },
      { method: 'GET', path: 'x402-jrey.vercel.app/api/realestate/yield?area=tokyo', price: '$0.30', daily: true, desc: L('日本の不動産利回り。エリア指定。', 'Japan real-estate yield, by area.') },
      { method: 'GET', path: 'x402nansenpolymarket.vercel.app/api/divergence/scan', price: '$0.15', stopped: true, desc: L('予測市場とオンチェーンフローの乖離スキャン。', 'Scan of divergence between prediction markets and on-chain flows.') },
      { method: 'GET', path: 'x402-hl.vercel.app/api/hyperliquid/scan', price: '$0.20', desc: L('Hyperliquidの建玉・ファンディングとスマートマネーの偏り。', 'Hyperliquid open interest, funding and smart-money skew.') },
      { method: 'GET', path: 'smartmoneyscreener.vercel.app/api/screener/smart-money', price: '$0.05', stopped: true, desc: L('スマートマネーが買っているトークンのスクリーニング。', 'Screens the tokens smart money is buying.') },
      { method: 'GET', path: 'x402oif.vercel.app/api/feed/apac-daily', price: '$0.10', stopped: true, desc: L('APACの日次オンチェーンサマリー。', 'Daily APAC on-chain summary.') },
      { method: 'GET', path: 'x402oif.vercel.app/api/feed/whale-alert', price: '$0.20', stopped: true, desc: L('大口転送のアラート。', 'Alerts on large transfers.') },
      { method: 'GET', path: 'odo-gamma.vercel.app/funding/nowcast/current', price: '$0.01', daily: true, desc: L('perpのファンディング・ナウキャスト。バスケット別。', 'Perp funding nowcast, by basket.') },
    ],
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Stats row of a panel, in the Latest run card's markup. */
function setStats(id, stats) {
  // An optional third item is the stat's definition, shown on hover.
  document.getElementById(id).innerHTML = stats.map(([n, l, def]) =>
    `<div class="stat"${def ? ` title="${esc(def)}"` : ''}><span class="stat__n">${esc(n)}</span><span class="stat__l">${esc(l)}</span></div>`).join('');
}
const shortDate = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
};

/** Path key used to match a catalog row against a captured sample. */
function pathKey(p) {
  const withoutHost = p.startsWith('/') ? p : '/' + p.split('/').slice(1).join('/');
  return withoutHost.split('?')[0];
}

function renderGroups() {
  const host = document.getElementById('groups');
  if (!host) return;
  host.innerHTML = GROUPS.map((g) => {
    const rows = g.eps.map((ep) => {
      const key = pathKey(ep.path);
      return `
      <div class="ep" data-path="${esc(key)}">
        <div class="ep__top">
          <code class="ep__code"><span class="ep__m">${esc(ep.method)}</span> <span class="ep__p">${esc(ep.path)}</span></code>
          <span class="pill ${ep.free ? 'pill--ok' : 'pill--pay'}">${ep.free ? '200' : '402'}</span>
          <span class="ep__price">${ep.free ? 'free' : esc(ep.price)}</span>
          ${ep.daily ? '<span class="chip-on">daily ✓</span>' : ''}
          ${ep.stopped ? `<span class="chip-stop">${L('購入停止', 'Stopped')}</span>` : ''}
        </div>
        <p class="ep__desc">${esc(ep.desc)}</p>
        <div class="ep__sample" data-sample></div>
      </div>`;
    }).join('');
    return `
      <section class="grp">
        <div class="grp__head">
          <h3 class="grp__name">${esc(g.name)}</h3>
          ${g.host ? `<code class="grp__host">host: ${esc(g.host)}</code>` : ''}
        </div>
        ${rows}
        <p class="grp__note">${esc(g.note)}</p>
      </section>`;
  }).join('');
}
renderGroups();

/* ── Response samples: what the agent actually got back ───────────────────
   Real captured bodies from /api/samples. Rows the agent has never called
   simply say so rather than showing an invented example. */
async function loadSamples() {
  let samples = [];
  try {
    const res = await fetch('/api/samples');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    samples = (await res.json()).samples || [];
  } catch {
    document.querySelectorAll('[data-sample]').forEach((el) => {
      el.innerHTML = '<p class="sample__none">Response data unavailable.</p>';
    });
    return;
  }

  const byPath = new Map(samples.map((s) => [s.path, s]));

  document.querySelectorAll('.ep').forEach((row) => {
    const slot = row.querySelector('[data-sample]');
    if (!slot) return;
    const key = row.getAttribute('data-path');
    let s = byPath.get(key);
    // ":ticker" style rows match whatever concrete path the agent actually used.
    if (!s && key.includes(':')) {
      const prefix = key.slice(0, key.indexOf(':'));
      for (const [p, v] of byPath) if (p.startsWith(prefix)) { s = v; break; }
    }
    if (!s) {
      slot.innerHTML = '<p class="sample__none">Not called by this agent — no captured response.</p>';
      return;
    }

    const when = new Date(s.at).toLocaleDateString(LOCALE);
    const tx = s.txHash
      ? `<a class="sample__tx" href="${txUrl(s.txHash)}" target="_blank" rel="noopener">${esc(shortTx(s.txHash))}</a>`
      : '';
    const body = s.sample !== undefined
      ? `<pre class="sample__pre">${esc(JSON.stringify(s.sample, null, 2))}</pre>`
        + (s.truncated ? '<p class="sample__note">Trimmed for display — the agent stored the full body.</p>' : '')
      : `<p class="sample__note">Body not captured for this endpoint. Logged excerpt: <code>${esc(s.peek || '—')}</code></p>`;

    slot.innerHTML = `
      <details class="sample">
        <summary class="sample__sum">
          <span>Response data</span>
          <span class="sample__meta">${esc(when)} · ${esc(s.status)}${tx ? ' · ' : ''}${tx}</span>
        </summary>
        ${body}
      </details>`;
  });
}

/* ── Live "latest run" card ─────────────────────────────────────────────── */
const money = (n) => '$' + (Number(n) || 0).toFixed(3);
/** 百万円の表示。null/未取得は「—」(0で埋めない)。 */
const fmtM = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(LOCALE));
const shortTx = (t) => (t ? t.slice(0, 6) + '…' + t.slice(-4) : '');
const txUrl = (t) => (t && t.startsWith('0x') ? 'https://basescan.org/tx/' + t : 'https://solscan.io/tx/' + t);
/** Path of a called URL, to match a settlement against its captured sample. */
const pathOf = (u) => { try { return new URL(u.indexOf('://') >= 0 ? u : 'https://' + u).pathname; } catch { return u || ''; } };

/** Local YYYY-MM-DD of a run timestamp, used to group one day's modes together. */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function loadRun() {
  const settle = document.getElementById('settle');
  try {
    const res = await fetch('/api/runs?limit=40');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    const runs = payload.runs || [];
    // Endpoints no longer bought: left out of the rows (older days still carry
    // them) and listed once, under 購入停止.
    const stoppedEps = payload.stopped || [];
    const stoppedUrls = new Set(stoppedEps.map((x) => x.url));
    if (!runs.length) {
      if (settle) settle.innerHTML = '<li class="settle__empty">No runs recorded yet.</li>';
      return;
    }

    // One daily run is several modes in sequence (B → A → D), so aggregate the
    // whole day rather than picking the newest single mode. Picking the newest
    // always landed on Mode D, which runs last and is the smallest slice of the
    // day's spend.
    const ordered = runs.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const latestDay = dayKey(ordered[ordered.length - 1].timestamp);
    const today = ordered.filter((r) => dayKey(r.timestamp) === latestDay);

    const results = today.flatMap((r) => r.results || []).filter((r) => !stoppedUrls.has(r.endpoint));
    const paid = results.filter((r) => r.txHash);
    const spend = today.reduce((a, r) => a + (Number(r.totalCostUsdc) || 0), 0);

    document.getElementById('run-when').textContent =
      new Date(today[today.length - 1].timestamp).toLocaleDateString(LOCALE);
    // A cooled-down endpoint was intentionally not bought — don't count it as a
    // failed call in the OK ratio (it is neither success nor a real attempt).
    const isCooldown = (r) => r.status === 'degraded' && /^cooldown/.test(r.degradedReason || '');
    const attempted = results.filter((r) => !isCooldown(r));

    document.getElementById('stat-spend').textContent = money(spend);
    document.getElementById('stat-tx').textContent = paid.length;
    const okCalls = attempted.filter((r) => r.status === 'success');
    document.getElementById('stat-ok').textContent = okCalls.length + '/' + attempted.length;
    // Content OK: of the OK calls, those whose body carried something. A call
    // whose body was not kept in full (before 11/13) cannot be judged and is
    // left out of both sides rather than guessed.
    const judged = okCalls.filter((r) => r.content);
    const emptyBody = (r) => r.status === 'success' && r.content && r.content.ok === false;
    const contentEl = document.getElementById('stat-content');
    if (contentEl) {
      contentEl.textContent = judged.length
        ? judged.filter((r) => r.content.ok).length + '/' + judged.length
        : '—';
      contentEl.parentElement.title = contentEl.parentElement.title.split('\n')[0] +
        (judged.length < okCalls.length ? L(`\n本文が残っておらず判定できない ${okCalls.length - judged.length} 件は数えていない`, `\n${okCalls.length - judged.length} calls without a kept body are not counted`) : '');
    }

    if (settle) {
      // Figures the agent actually received, keyed by path, so each row can show
      // what was bought instead of only that something was.
      const factsByPath = new Map();
      try {
        const sres = await fetch('/api/samples');
        if (sres.ok) {
          for (const s of (await sres.json()).samples || []) {
            if (s.highlights && s.highlights.length) factsByPath.set(s.path, s.highlights);
          }
        }
      } catch { /* highlights are additive — the list still renders without them */ }

      // Show everything the day touched: settled rows, plus any that came back
      // degraded (paid but fallback/stub data) or errored — with the reason — so
      // the "N/M OK" count is legible instead of one row silently missing.
      const shown = results.filter((r) => r.txHash || r.status === 'degraded' || r.status === 'error');
      const dailyHtml = shown.map((r) => {
        const cooldown = isCooldown(r);
        const hollow = emptyBody(r);
        const bad = r.status === 'degraded' || r.status === 'error' || hollow;
        const badge = cooldown ? L('休止', 'Paused') : r.status === 'degraded' ? L('劣化', 'Degraded') : r.status === 'error' ? L('失敗', 'Failed') : hollow ? L('中身なし', 'Empty') : '';
        const reason = r.status === 'degraded'
          ? tr(r.degradedReason || 'fallback data')
          : r.status === 'error' ? (r.error || 'failed')
          : hollow ? tr(r.content.reason || L('中身なし', 'empty')) : '';
        const facts = factsByPath.get(pathOf(r.endpoint || '')) || [];
        const line = bad
          ? `<div class="settle__reason">${esc(String(reason).slice(0, 90))}</div>`
          : (facts.length
              ? `<div class="settle__facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>`
              : (r.responsePeek ? `<div class="settle__facts settle__facts--raw">${esc(String(r.responsePeek).slice(0, 70))}</div>` : ''));
        return `
        <li class="settle__row${bad ? ' settle__row--bad' : ''}">
          <div class="settle__head">
            <span class="settle__name">${esc(r.product || r.endpoint)}${badge ? ` <span class="settle__badge">${badge}</span>` : ''}</span>
            <span class="settle__cost">${money(r.costUsdc)}</span>
            ${r.txHash
              ? `<a class="settle__tx" href="${txUrl(r.txHash)}" target="_blank" rel="noopener">${esc(shortTx(r.txHash))}</a>`
              : '<span class="settle__tx settle__tx--none">no tx</span>'}
          </div>
          ${line}
        </li>`;
      }).join('');
      const stoppedHtml = stoppedEps.length
        ? `<li class="settle__group">${esc(L(`購入停止 · ${stoppedEps[0].since} から`, `Stopped · since ${stoppedEps[0].since}`))}</li>` + stoppedEps.map((x) => `
        <li class="settle__row settle__row--bad">
          <div class="settle__head"><span class="settle__name">${esc(x.name)} <span class="settle__badge">${L('購入停止', 'Stopped')}</span></span></div>
          <div class="settle__reason" title="${esc(tr(x.reason))}">${esc(tr(x.reason))}</div>
        </li>`).join('') +
          (payload.modeA && payload.modeA.stopped ? `<li class="settle__note">${esc(L('Mode A(判断)も停止中: ', 'Mode A (decisions) is stopped too: ') + tr(payload.modeA.stopped))}</li>` : '')
        : '';
      // The weekly sweeps have their own cards; this one is the daily run only.
      settle.innerHTML = (dailyHtml || '<li class="settle__empty">No settlements yet.</li>') + stoppedHtml;
    }
  } catch (e) {
    if (settle) settle.innerHTML = `<li class="settle__empty">Could not load run data (${esc(String(e))}).</li>`;
  }
}
loadRun();
setInterval(loadRun, 60000);

/* ── Panels: EDINET / External probe / Arcium MXE ──────────────────────────
   Each card holds every record of its latest run in a list that scrolls inside
   the card. Nothing is filled in: a missing field shows "—" and a failure shows
   its reason. */
const txLink = (t, label) => t
  ? `<a class="settle__tx" href="${txUrl(t)}" target="_blank" rel="noopener">${esc(label || shortTx(t))}</a>`
  : '<span class="settle__tx settle__tx--none">no tx</span>';
const row = ({ name, badge, badgeOk, cost, tx, line, bad }) => `
  <li class="settle__row${bad ? ' settle__row--bad' : ''}">
    <div class="settle__head">
      <span class="settle__name">${name}${badge ? ` <span class="settle__badge${badgeOk ? ' settle__badge--ok' : ''}">${esc(badge)}</span>` : ''}</span>
      ${cost != null ? `<span class="settle__cost">${esc(cost)}</span>` : ''}
      ${tx ?? ''}
    </div>
    ${line ?? ''}
  </li>`;
const facts = (xs) => `<div class="settle__facts">${xs.filter(Boolean).map((f) => `<span>${esc(f)}</span>`).join('')}</div>`;
const reason = (t) => `<div class="settle__reason" title="${esc(t)}">${esc(String(t).slice(0, 120))}</div>`;
const group = (t) => `<li class="settle__group">${esc(t)}</li>`;
const note = (t) => `<li class="settle__note">${t}</li>`;
const empty = (t) => `<li class="settle__empty">${esc(t)}</li>`;

/* EDINET weekly: every company settled in the latest sweep, one per-call
   payment each. Paged from the API as the list is scrolled to its end. */
const edinet = { week: null, offset: 0, total: 0, loading: false };

async function loadEdinetPage() {
  const list = document.getElementById('edinet-list');
  if (!list || edinet.loading || (edinet.offset > 0 && edinet.offset >= edinet.total)) return;
  edinet.loading = true;
  try {
    const url = `/api/sweeps/edinet/${encodeURIComponent(edinet.week)}/items?offset=${edinet.offset}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const page = await res.json();
    const start = page.offset || 0;
    const items = page.items || [];
    list.querySelector('.settle__more')?.remove();
    list.insertAdjacentHTML('beforeend', items.map((it, i) => {
      const label = it.name ? `${it.name} (${it.ticker})` : (it.ticker || '—');
      // What the answer named: the disclosure's metadata. Sweeps before 11/13
      // did not keep the body, so their rows carry the settlement only.
      const m = it.meta || {};
      const missing = it.content && it.content.ok === false;
      const line = missing
        ? reason(tr(it.content.reason || L('中身なし', 'empty')))
        : it.meta
          ? facts([m.docDescription, m.submitDatetime && L(`提出 ${String(m.submitDatetime).slice(0, 10)}`, `filed ${String(m.submitDatetime).slice(0, 10)}`), m.period && L(`期間 ${m.period}`, `period ${m.period}`)])
          : '';
      return row({
        name: `<span class="settle__idx">#${start + i + 1}</span> ${esc(label)}`, badge: missing ? L('中身なし', 'Empty') : '', bad: missing,
        cost: money(it.amountUsdc), tx: txLink(it.tx), line,
      });
    }).join(''));
    edinet.offset = start + items.length;
    edinet.total = page.total || 0;
    if (edinet.offset < edinet.total) list.insertAdjacentHTML('beforeend', `<li class="settle__empty settle__more">${edinet.offset}/${edinet.total}${L('件 — スクロールで続きを読み込む', ' — scroll to load more')}</li>`);
    else list.insertAdjacentHTML('beforeend', note(L('EDINET の全提出者 約4,000社のうち、今週 AA が per-call で実決済した社。1コールで買うのは1社の最新の開示書類のメタデータ(提出者・書類ID・書類種別・提出日時・会計期間)。売上・利益などの財務値は osd が提供を止めており、応答には入らない。株価も含まない。出典：金融庁 EDINET。', 'Companies, of the ~4,000 EDINET filers, that AA paid for per call this week. One call buys one company\'s latest disclosure metadata (filer, document id, document type, submission time, accounting period). Financial figures such as sales and profit are not served by osd and are not in the answer; neither are share prices. Source: EDINET, Financial Services Agency of Japan.')));
  } catch (e) {
    list.insertAdjacentHTML('beforeend', empty(L(`読み込めなかった (${e})`, `Could not load (${e})`)));
    edinet.total = edinet.offset;   // stop paging
  } finally { edinet.loading = false; }
}

async function loadEdinet() {
  const list = document.getElementById('edinet-list');
  if (!list) return;
  try {
    const res = await fetch('/api/sweeps');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // Catalyst の週次記録はこの枠に出さない(本体は osd 側のスコア付き予測)。
    const sp = await res.json();
    const payloadBase = (sp.osdBase || '').replace(/^https?:\/\//, '');
    const s = (sp.sweeps || []).find((x) => x.surface === 'edinet');
    if (!s) { list.innerHTML = empty(L('まだ記録がない。', 'No records yet.')); return; }
    document.getElementById('edinet-when').textContent = [s.week, shortDate(s.at)].filter(Boolean).join(' · ');
    const c = s.content;
    setStats('edinet-stats', [
      [money(s.totalUsdc), 'USDC spent'], [String(s.settlements ?? '—'), 'Settlements'],
      [c ? `${c.ok}/${c.ok + c.missing}` : '—', 'Content OK',
        c ? L('書類を特定できた応答(書類ID・提出者・提出日時がそろう)/ 判定した応答', 'Answers that identify a document (document id, filer and submission time present) / answers judged') : L('この週は応答の本文を保存していないため判定できない(11/13 以降の週から記録)', 'Not judged: bodies were not kept this week (recorded from the weeks after 11/13)')],
    ]);
    // What one call buys: the paid route and its unit, above the list.
    const head = [
      s.endpoint && note(L(`買っているもの: <code class="settle__path">${esc((payloadBase || '') + s.endpoint)}</code> を1社1コール ${s.unitUsd != null ? "$" + Number(s.unitUsd).toFixed(3) : "—"}(Solana USDC)。中身は${esc(s.unit || '開示書類のメタデータ')}。`, `What is bought: <code class="settle__path">${esc((payloadBase || '') + s.endpoint)}</code>, one call per company at ${s.unitUsd != null ? "$" + Number(s.unitUsd).toFixed(3) : "—"} (Solana USDC). Each answer is ${esc(tr(s.unit) || 'disclosure metadata')}.`)),
      c && (c.missing || c.financials) ? note(L(`内訳: 中身あり ${c.ok}件・欠け ${c.missing}件`, `Breakdown: ${c.ok} with content, ${c.missing} missing`) +
        (Object.keys(c.reasons || {}).length ? `(${Object.entries(c.reasons).map(([k, n]) => `${esc(tr(k))} ${n}`).join(L('、', ', '))})` : '') +
        L(`・財務値入り ${c.financials}件`, `, ${c.financials} with financial figures`)) : '',
      s.stopped ? `<li class="settle__reason">${esc(tr(s.stopped))}</li>` : '',
    ].filter(Boolean).join('');
    list.innerHTML = head;
    Object.assign(edinet, { week: s.week, offset: 0, total: s.settlements || 0 });
    await loadEdinetPage();
    list.addEventListener('scroll', () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) loadEdinetPage();
    }, { passive: true });
  } catch (e) { list.innerHTML = empty(`Could not load (${e})`); }
}
loadEdinet();

/* External x402 probe: third-party sellers, paid once a week. The quoted price
   (from the seller's 402) and the settled charge are kept apart — the point is
   to see where they disagree. */
let sellerNames = {};
const sellerName = (id) => sellerNames[id] || id;
const money6 = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toFixed(6));
const chainLabel = (c) => {
  if (!c) return '';
  if (c.startsWith('eip155:8453') || c === 'base') return 'Base';
  if (c.startsWith('solana')) return 'Solana';
  if (c.startsWith('eip155:5042') || c === 'arc') return 'Arc';
  return c;
};

/* Daily path: external endpoints Seller Probe judged 説明どおり, bought every
   morning the way Seller Probe bought them. Rendered above the weekly probe in
   the same card, each under its own heading. */
async function spBuySection() {
  try {
    const res = await fetch('/api/spbuy?limit=1');
    if (!res.ok) return null;
    const p = await res.json();
    const run = (p.runs || [])[0];
    if (!run) return { stats: null, html: group(L('毎朝 · Seller Probe 連動', 'Daily · driven by Seller Probe')) + empty(L('まだ実行していない。', 'Not run yet.')) };
    const labels = p.labels || {};
    const recs = run.records || [];
    const paid = recs.filter((r) => r.tx);
    const ok = recs.filter((r) => r.verdict === 'as_described');
    const ops = new Set(paid.map((r) => r.operator));
    const rows = recs.map((r) => {
      const good = r.verdict === 'as_described';
      let pathName = r.url;
      try { pathName = new URL(r.url).pathname; } catch { /* keep the URL */ }
      const fails = (r.checks || []).filter((c) => c.result === 'fail').map((c) => `${c.name}: ${c.detail}`);
      return row({
        name: `${esc(r.host)} <code class="settle__path">${esc(pathName)}</code>`,
        badge: good ? '' : L(labels[r.verdict] || r.verdict, VERDICT_EN[r.verdict] || r.verdict), bad: !good,
        cost: r.amount_usd != null ? money6(r.amount_usd) : `${money6(r.quoted_usd ?? r.price_usd)} ${L('未払い', 'unpaid')}`,
        tx: r.tx ? txLink(r.tx) : '',
        line: facts([r.category, r.network && chainLabel(r.network), L(`Probe の判定 ${r.selection && r.selection.probeDate}: 説明どおり`, `Seller Probe ${r.selection && r.selection.probeDate}: as described`),
          r.tx_source === 'onchain_search' && L('決済ヘッダなし・送金はチェーンで確認', 'no settlement header; transfer confirmed on chain')]) +
          (good ? '' : reason(fails.length ? fails.join(' / ') : tr(r.verdict_reason))),
      });
    }).join('');
    const nc = run.notCalled || [];
    const skipped = nc.length
      ? note(L(`今日は買わなかった ${nc.length} 件: `, `Not bought today (${nc.length}): `) + `${esc(nc.slice(0, 3).map((n) => `${n.host} (${tr(n.reason)})`).join(L('、', ', ')))}${nc.length > 3 ? L(' ほか', ' and more') : ''}`)
      : '';
    return {
      stats: [[String(paid.length), 'Bought'], [String(ops.size), 'Operators'], [`${ok.length}/${paid.length}`, 'Content OK'], [money(run.spentUsd), 'USDC']],
      when: run.date,
      html: group(L(`毎朝 · Seller Probe 連動 · ${run.date}`, `Daily · driven by Seller Probe · ${run.date}`)) + rows + skipped +
        note(L(`Seller Probe が直近 14 日に「説明どおり」と判定した外部エンドポイントを、その判定のときと同じ要求で毎朝 1 回ずつ買う(1 回 $0.01 以下、1 日 $${Number(run.dailyCapUsd).toFixed(2)} まで、1 事業者 2 本まで)。中身の判定は Seller Probe と同じ 5 つの確認。`,
          `External endpoints that Seller Probe judged "as described" in the last 14 days, bought once every morning with the same request Seller Probe used (≤ $0.01 a call, ≤ $${Number(run.dailyCapUsd).toFixed(2)} a day, ≤ 2 per operator). The content is judged with Seller Probe's five checks.`)),
    };
  } catch { return null; }
}

async function loadProbe() {
  const list = document.getElementById('probe-list');
  if (!list) return;
  try {
    const daily = await spBuySection();
    const res = await fetch('/api/probes?limit=12');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    sellerNames = payload.targets || {};
    // The newest PAID run; a discovery run settles nothing.
    const run = (payload.probes || []).find((r) => r.mode === 'sweep');
    if (!run) { list.innerHTML = empty(L('まだ記録がない。', 'No records yet.')); return; }
    // Suspended sellers are out of the sweep. Older runs still carry a skipped
    // row for them; leave those out and list the sellers once, under 停止中.
    const suspended = payload.suspended || [];
    const off = new Set(suspended.map((x) => x.id));
    const rows = (run.records || []).filter((r) => !off.has(r.target));
    const paid = rows.filter((r) => r.outcome === 'paid');
    const sellers = new Set(paid.map((r) => r.target));
    document.getElementById('probe-when').textContent = daily && daily.when
      ? daily.when
      : [run.week, shortDate(run.at)].filter(Boolean).join(' · ');
    // The daily path is the bigger one, so its figures lead; the weekly probe's
    // own figures move to its heading.
    setStats('probe-stats', daily && daily.stats
      ? daily.stats
      : [[money(run.runSpentUsdc), 'USDC spent'], [String(sellers.size), 'Sellers'], [`${paid.length}/${rows.length}`, 'Paid']]);
    const weeklyHead = group(L(`週次プローブ · ${[run.week, shortDate(run.at)].filter(Boolean).join(' · ')} · ${money(run.runSpentUsdc)} · ${paid.length}/${rows.length} 決済`, `Weekly probe · ${[run.week, shortDate(run.at)].filter(Boolean).join(' · ')} · ${money(run.runSpentUsdc)} · ${paid.length}/${rows.length} paid`));

    const bySeller = (run.summaries || []).filter((s) => !off.has(s.target)).map((s) => {
      // A seller with no paid call shows why: the skip reason of its first row.
      const allSkipped = s.paidCalls === 0 && s.skipped > 0 && !s.errors;
      const why = rows.find((r) => r.target === s.target && r.outcome !== 'paid' && r.reason);
      return row({
        name: esc(sellerName(s.target)),
        badge: allSkipped ? L('買わず', 'Not bought') : L(`成功 ${Math.round((s.successRate || 0) * 100)}%`, `${Math.round((s.successRate || 0) * 100)}% OK`),
        badgeOk: s.paidCalls > 0 && !s.errors, bad: s.paidCalls === 0,
        cost: s.paidCalls > 0 ? money6(s.measuredPerCallUsdc) + '/call' : '—',
        line: facts([L(`${s.paidCalls}/${s.calls} 決済`, `${s.paidCalls}/${s.calls} paid`), s.skipped && `${s.skipped} skip`, s.errors && `${s.errors} err`]) +
          (s.paidCalls === 0 && why ? reason(L('理由: ', 'Reason: ') + tr(why.reason)) : ''),
      });
    }).join('');
    const offRows = suspended.map((x) => row({
      name: esc(x.name), badge: L('停止中', 'Suspended'), bad: true, cost: L(`${x.since} から`, `since ${x.since}`),
      line: reason(tr(x.reason)),
    })).join('');
    const calls = rows.map((r) => {
      const ok = r.outcome === 'paid';
      return row({
        name: `${esc(sellerName(r.target))} <code class="settle__path">${esc(r.path)}</code>`,
        badge: ok ? '' : r.outcome, bad: !ok,
        cost: `${money6(r.quotedUsdc)} → ${money6(r.actualUsdc)}`,
        tx: txLink(r.txHash),
        line: ok ? facts([chainLabel(r.chain), r.latencyMs != null && `${r.latencyMs}ms`]) : (r.reason ? reason(tr(r.reason)) : ''),
      });
    }).join('');
    list.innerHTML = (daily ? daily.html : '') + weeklyHead + group(L('売り手別', 'By seller')) + bySeller + group(L('コール別 · 提示 → 実課金', 'By call · quoted → charged')) + calls +
      (offRows ? group(L('停止中 · 実行対象外', 'Suspended · not called')) + offRows : '') +
      note(L('週次プローブ: 自社の外にある第三者の x402 売り手(OneSource・2s・Otto AI・Exa)に週1回支払い、実費と内容を測っている。提示額は売り手の 402 から、実課金は決済レスポンスから取る。',
        "Weekly probe: third-party x402 sellers outside our own stack (OneSource, 2s, Otto AI, Exa), paid once a week to measure real cost and content. The quote comes from the seller's 402, the charge from the settlement response."));
  } catch (e) { list.innerHTML = empty(`Could not load (${e})`); }
}
loadProbe();

/* Arcium MXE: the five sealed functions. Where the computation ran (Arcium)
   and where a payment settled (Solana mainnet) are shown apart. */
const compUrl = (a, net) =>
  'https://explorer.solana.com/address/' + a + (net === 'arcium-devnet' ? '?cluster=devnet' : '');
const ms = (n) => (n == null ? '—' : Math.round(n).toLocaleString(LOCALE) + 'ms');
const usd = (n) => (n == null ? '—' : '$' + Number(n).toFixed(6));
const netLabel = (n) => ({ 'arcium-devnet': 'devnet', 'arcium-mainnet': 'mainnet', 'arcium-localnet': 'localnet' }[n] || n || '—');
const partyLabel = (c) => ({ internal: L('内部取引', 'internal'), self: L('自己', 'self'), external: L('外部', 'external') }[c] || c);

function mxeResult(r) {
  const x = r.result || {};
  switch (r.fn) {
    case 1: return x.matched ? L(`成立 ${usd(Number(x.priceMicro) / 1e6)}`, `matched ${usd(Number(x.priceMicro) / 1e6)}`) : L('不成立', 'no match');
    case 2: return x.winner ? L(`落札 ${shortTx(x.winner)} ${usd(Number(x.priceMicro) / 1e6)}`, `awarded ${shortTx(x.winner)} ${usd(Number(x.priceMicro) / 1e6)}`) : '';
    case 3: return x.ratingCount != null ? L(`評価 ${x.ratingCount}件(集計のみ公開)`, `${x.ratingCount} ratings (only totals revealed)`) : '';
    case 4: return x.reached === undefined ? '' : x.reached ? L(`到達(${x.participants}者)`, `reached (${x.participants} parties)`) : L('未到達・誰も払わない', 'not reached; nobody pays');
    case 5: return x.catalogSize ? L(`N=${x.catalogSize} 一致 ${(x.matches || []).length}件`, `N=${x.catalogSize}, ${(x.matches || []).length} matches`) : '';
    default: return '';
  }
}

async function loadMxe() {
  const list = document.getElementById('mxe-list');
  if (!list) return;
  try {
    const res = await fetch('/api/mxe?limit=30');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    const records = p.records || [];   // newest first
    if (!p.total) { list.innerHTML = empty(L('まだ記録がない。', 'No records yet.')); return; }

    const latest = new Map();
    for (const r of records) if (!latest.has(r.fn)) latest.set(r.fn, r);
    const okFns = [...latest.values()].filter((r) => r.status === 'ok').length;
    const okRuns = p.aggregates.reduce((a, g) => a + g.ok, 0);
    const pays = records.reduce((a, r) => a + (r.paymentTxs || []).length, 0);
    document.getElementById('mxe-when').textContent = records[0] ? shortDate(records[0].at) : '—';
    const DEF_FNS = L('5機能のうち、直近の記録が成功だった機能の数', 'Functions, of the five, whose latest record succeeded');
    const DEF_RUNS = L('これまでに成功した計算の累計(停止中の記録は数えない)', 'Successful computations to date (paused records not counted)');
    const DEF_PAYS = L('直近30件の記録にある x402 支払い tx の数', 'x402 payment txs in the latest 30 records');
    setStats('mxe-stats', [[`${okFns}/5`, 'Functions', DEF_FNS], [String(okRuns), 'Runs', DEF_RUNS], [String(pays), 'Payments', DEF_PAYS]]);
    const stageLabel = (s) => L((p.stageLabels && p.stageLabels[s]) || s, STAGE_EN[s] || s);

    const byFn = p.aggregates.map((g) => {
      const f = p.functions.find((x) => x.fn === g.fn) || {};
      // The newest run of the function decides the badge; the totals follow.
      const last = latest.get(g.fn);
      const lastOk = last && last.status === 'ok';
      return row({
        name: `${g.fn}. ${esc(L(g.label, MXE_FN_EN[g.fn] || g.label))}`,
        badge: f.enabled === false ? L('無効', 'Disabled') : f.paused ? L('停止中', 'Paused') : !last ? L('記録なし', 'No record') : lastOk ? L('成功', 'OK') : L('失敗', 'Failed'),
        badgeOk: f.enabled !== false && !f.paused && lastOk, bad: f.paused || (last && !lastOk),
        cost: usd(g.costUsd && g.costUsd.mean),
        line: (f.paused ? reason(L(`${shortDate(f.paused.at)} から停止: `, `paused since ${shortDate(f.paused.at)}: `) + tr(f.paused.reason)) : '') + facts([
          L(`${g.ok}/${g.runs} 成功`, `${g.ok}/${g.runs} OK`),
          g.paused && L(`停止中の記録 ${g.paused}`, `${g.paused} paused records`),
          last && !lastOk && last.stage && L(`直近の失敗: ${stageLabel(last.stage)}`, `latest failure: ${stageLabel(last.stage)}`),
          L(`平均 ${ms(g.latencyMs && g.latencyMs.mean)}`, `avg ${ms(g.latencyMs && g.latencyMs.mean)}`),
          g.unitCostRatio && L(`単価比 ${g.unitCostRatio.mean.toFixed(2)}`, `unit-cost ratio ${g.unitCostRatio.mean.toFixed(2)}`),
          g.compared && L(`比較 ${g.compared}`, `compared ${g.compared}`),
          g.networks.length && g.networks.map(netLabel).join('/'),
        ]),
      });
    }).join('');
    const recs = records.map((r) => {
      const ok = r.status === 'ok';
      const comp = r.computationAccount
        ? `<a class="settle__tx" href="${compUrl(r.computationAccount, r.network)}" target="_blank" rel="noopener">${L('計算', 'computation')}</a>`
        : `<span class="settle__tx settle__tx--none">${L('計算なし', 'no computation')}</span>`;
      const payLinks = (r.paymentTxs || []).map((t) => txLink(t, L('支払', 'payment'))).join('');
      const line = ok
        ? facts([netLabel(r.network) + (r.paymentNetwork ? ' → Solana' : ''), ms(r.latencyMs), partyLabel(r.counterparty),
            r.unitCostRatio != null && L(`単価比 ${r.unitCostRatio.toFixed(2)}`, `unit-cost ratio ${r.unitCostRatio.toFixed(2)}`),
            r.comparison && L(`比較(${r.comparison.method}) `, `compared (${r.comparison.method}) `) + JSON.stringify(r.comparison.result)])
        : reason(tr(r.error || 'failed'));
      const badge = ok ? '' : r.status === 'paused' ? L('停止中', 'Paused') : L(`失敗: ${stageLabel(r.stage || 'queue')}`, `failed: ${stageLabel(r.stage || 'queue')}`);
      return row({
        name: `#${r.fn} ${esc(mxeResult(r) || '—')}`, badge, bad: !ok,
        cost: `${shortDate(r.at)} · ${usd(r.costUsd)}`, tx: comp + payLinks, line,
      });
    }).join('');
    const fs = (p.failuresByStage && p.failuresByStage.stages) || [];
    const byStage = fs.map((x) => row({
      name: esc(stageLabel(x.stage)), badge: L(`${x.count}件`, `${x.count}`), bad: x.stage !== 'paused',
      cost: `${shortDate(x.first)}–${shortDate(x.last)}`,
      line: facts([L(`機能 ${x.fns.join('・')}`, `functions ${x.fns.join(', ')}`)]) + (x.sample ? reason(tr(x.sample)) : ''),
    })).join('');
    const rs = p.rentSweep;
    const rentLine = rs ? note(L(`計算アカウントの rent: ${shortDate(rs.at)} の回収で ${rs.claimed}件・${(rs.claimedLamports / 1e9).toFixed(4)} SOL を回収。`, `Computation-account rent: the ${shortDate(rs.at)} sweep reclaimed ${rs.claimed} accounts, ${(rs.claimedLamports / 1e9).toFixed(4)} SOL.`) +
      (rs.stillQueued ? L(` 未実行のまま期限前の ${rs.stillQueued}件(${(rs.stillQueuedLamports / 1e9).toFixed(4)} SOL)は期限後に毎回の実行で回収する。`, ` ${rs.stillQueued} never-executed accounts (${(rs.stillQueuedLamports / 1e9).toFixed(4)} SOL) are reclaimed by later runs once they expire.`) : '')) : '';
    const defs = note(L(`Functions = 直近の記録が成功した機能の数/5。Runs = 成功した計算の累計。Payments = 直近30件にある支払い tx の数。` +
      `同じ段階で ${p.breakerDays || 3} 日続けて失敗した機能は止め、手動で再開するまで実行しない。`,
      `Functions = functions whose latest record succeeded, of 5. Runs = successful computations to date. Payments = payment txs in the latest 30 records. ` +
      `A function that fails at the same stage ${p.breakerDays || 3} days in a row is paused until resumed by hand.`));
    list.innerHTML = defs + group(L('機能別 · 平均', 'By function · average')) + byFn +
      (byStage ? group(L(`失敗の段階 · ${shortDate(p.failuresByStage.since)} 以降`, `Failures by stage · since ${shortDate(p.failuresByStage.since)}`)) + byStage + rentLine : rentLine) +
      group(L('記録 · 新しい順', 'Records · newest first')) + recs +
      note(L('判定は Arcium のクラスタ、支払いは x402 で Solana mainnet。機能1・2・4 の相手方は AA 自身の内部エージェントで、外部需要の証拠ではない。devnet の SOL に市場価格はないため、USD は mainnet の SOL/USD で換算した目安。',
        "Computed on an Arcium cluster; paid with x402 on Solana mainnet. In functions 1, 2 and 4 the counterparty is AA's own internal agent, so they are not evidence of external demand. Devnet SOL has no market price; USD figures use mainnet SOL/USD as a guide.") +
        (p.jobEnabled ? L(' 毎日 07:30 JST に実行。', ' Runs daily at 07:30 JST.') : L(' 定時実行は停止中。', ' The scheduled run is off.')));
  } catch (e) { list.innerHTML = empty(`Could not load (${e})`); }
}
loadMxe();

/* ── Menu ───────────────────────────────────────────────────────────────── */
const menu = document.getElementById('menu');
const openBtn = document.getElementById('menu-open');
const closeBtn = document.getElementById('menu-close');
const backdrop = document.getElementById('menu-backdrop');
const links = menu ? menu.querySelectorAll('.menu__link') : [];

function setMenu(open) {
  if (!menu || !openBtn) return;
  menu.classList.toggle('is-open', open);
  openBtn.setAttribute('aria-expanded', String(open));
  if (open) closeBtn?.focus({ preventScroll: true });
  else openBtn.focus({ preventScroll: true });
}

openBtn?.addEventListener('click', () => setMenu(true));
closeBtn?.addEventListener('click', () => setMenu(false));
backdrop?.addEventListener('click', () => setMenu(false));
links.forEach((link) => link.addEventListener('click', () => setMenu(false)));

/* ── Endpoints overlay ──────────────────────────────────────────────────── */
const sheet = document.getElementById('endpoints');
const sheetOpen = document.getElementById('endpoints-open');
const sheetClose = document.getElementById('endpoints-close');
const sheetBackdrop = document.getElementById('endpoints-backdrop');

let samplesLoaded = false;

function setSheet(open) {
  if (!sheet || !sheetOpen) return;
  sheet.classList.toggle('is-open', open);
  sheetOpen.setAttribute('aria-expanded', String(open));
  if (open) {
    // Fetch the captured responses the first time the catalog is opened.
    if (!samplesLoaded) {
      samplesLoaded = true;
      loadSamples();
    }
    sheetClose?.focus({ preventScroll: true });
  } else {
    sheetOpen.focus({ preventScroll: true });
  }
}

sheetOpen?.addEventListener('click', () => setSheet(true));
sheetClose?.addEventListener('click', () => setSheet(false));
sheetBackdrop?.addEventListener('click', () => setSheet(false));

// The menu's Endpoints entry hands off to the same overlay.
document.querySelectorAll('[data-open-endpoints]').forEach((el) =>
  el.addEventListener('click', (e) => {
    e.preventDefault();
    setMenu(false);
    setSheet(true);
  })
);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (sheet?.classList.contains('is-open')) setSheet(false);
  else if (menu?.classList.contains('is-open')) setMenu(false);
});
