/** Menu, endpoints overlay, and the live "latest run" card. */

/* ── Endpoint catalog ──────────────────────────────────────────────────────
   Hosts are the x402jp.com custom domains. Prices and descriptions match the
   published catalog on x402jp.com/products.html. `daily` marks the endpoints
   this agent calls on its 06:00 JST schedule. */
const GROUPS = [
  {
    name: 'Japan Inflation Nowcast',
    host: 'jin.x402jp.com',
    note: '決済は Solana USDC（x402 v2）。discovery は /.well-known/x402.json。',
    eps: [
      { method: 'GET', path: '/api/jin/latest', free: true, daily: true, desc: '最新観測日の指数（excl_promo / incl_promo・matched・base_date・coverage・passthrough_gap）。' },
      { method: 'GET', path: '/api/jin/series', price: '$0.01', desc: '指数の時系列（from / to は任意）。' },
      { method: 'GET', path: '/api/jin/movers', price: '$0.02', daily: true, desc: 'その日動いた品目（特売タグ付き。date は任意）。' },
    ],
  },
  {
    name: 'Onchain Stock Data',
    host: 'osd.x402jp.com',
    note: '決済は Base または Solana USDC（dual）。402が両方のチェーンを提示するので、クライアントがどちらかを選ぶ。discovery は /.well-known/x402.json。',
    eps: [
      { method: 'GET', path: '/api/alpha/catalysts/physical-ai', free: true, desc: 'Physical-AI スコアボード（hit-rate・全86条件・記事別、機械可読 JSON）。' },
      { method: 'GET', path: '/api/alpha/portfolio/current', price: '$0.01', daily: true, desc: '米ポートフォリオ 現在10銘柄（ticker / weight / thesis）。' },
      { method: 'GET', path: '/api/alpha/portfolio/scorecard', price: '$0.01', daily: true, desc: '米 catalyst hit-rate ＋ SPY / QQQ 累積リターン。' },
      { method: 'GET', path: '/api/alpha/jp/portfolio/current', price: '$0.01', daily: true, desc: '日本ポートフォリオ 現在10銘柄。' },
      { method: 'GET', path: '/api/alpha/jp/scorecard', price: '$0.01', daily: true, desc: '日本 hit-rate（ベンチ指数なし）。' },
      { method: 'GET', path: '/api/alpha/jp/catalysts', price: '$0.01', daily: true, desc: '日本 dated catalysts 一覧。' },
      { method: 'POST', path: '/api/alpha/catalyst/submit', price: '$0.01', desc: '外部 catalyst 投稿（→ id ＋ score_lookup）。' },
      { method: 'GET', path: '/api/alpha/catalyst/:catalyst_id/score', price: '$0.01', desc: '投稿 catalyst の Claude 判定（pending / hit / partial / miss / na）。' },
    ],
  },
  {
    name: 'Intelligence',
    note: '決済は Base USDC。',
    eps: [
      { method: 'GET', path: 'x402amd.vercel.app/api/macro/dashboard', price: '$0.30', daily: true, desc: 'APACマクロ。金利・為替・フロー・リスク regime。' },
      { method: 'GET', path: 'x402yi.vercel.app/api/yield/scan', price: '$0.20', daily: true, desc: 'DeFiの利回りスキャン。プール別のAPYとスマートマネー残高。' },
      { method: 'POST', path: 'x402pi.vercel.app/api/portfolio/analyze', price: '$0.50', daily: true, desc: 'ウォレットアドレスを渡すとポートフォリオを分析。' },
      { method: 'GET', path: 'x402-jrey.vercel.app/api/realestate/yield?area=tokyo', price: '$0.30', daily: true, desc: '日本の不動産利回り。エリア指定。' },
      { method: 'GET', path: 'x402nansenpolymarket.vercel.app/api/divergence/scan', price: '$0.15', daily: true, desc: '予測市場とオンチェーンフローの乖離スキャン。' },
      { method: 'GET', path: 'x402-hl.vercel.app/api/hyperliquid/scan', price: '$0.20', desc: 'Hyperliquidの建玉・ファンディングとスマートマネーの偏り。' },
      { method: 'GET', path: 'smartmoneyscreener.vercel.app/api/screener/smart-money', price: '$0.05', daily: true, desc: 'スマートマネーが買っているトークンのスクリーニング。' },
      { method: 'GET', path: 'x402oif.vercel.app/api/feed/apac-daily', price: '$0.10', daily: true, desc: 'APACの日次オンチェーンサマリー。' },
      { method: 'GET', path: 'x402oif.vercel.app/api/feed/whale-alert', price: '$0.20', daily: true, desc: '大口転送のアラート。' },
      { method: 'GET', path: 'odo-gamma.vercel.app/funding/nowcast/current', price: '$0.01', daily: true, desc: 'perpのファンディング・ナウキャスト。バスケット別。' },
    ],
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
          ${ep.daily ? '<span class="chip-on">daily ✓</span>' : '<span class="chip-off">—</span>'}
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

    const when = new Date(s.at).toLocaleDateString('ja-JP');
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
    const runs = (await res.json()).runs || [];
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

    const results = today.flatMap((r) => r.results || []);
    const paid = results.filter((r) => r.txHash);
    const spend = today.reduce((a, r) => a + (Number(r.totalCostUsdc) || 0), 0);

    document.getElementById('run-when').textContent =
      new Date(today[today.length - 1].timestamp).toLocaleDateString('ja-JP');
    // A cooled-down endpoint was intentionally not bought — don't count it as a
    // failed call in the OK ratio (it is neither success nor a real attempt).
    const isCooldown = (r) => r.status === 'degraded' && /^cooldown/.test(r.degradedReason || '');
    const attempted = results.filter((r) => !isCooldown(r));

    document.getElementById('stat-spend').textContent = money(spend);
    document.getElementById('stat-tx').textContent = paid.length;
    document.getElementById('stat-ok').textContent =
      attempted.filter((r) => r.status === 'success').length + '/' + attempted.length;

    // Weekly per-call sweeps (EDINET / catalyst) lead the card — the "毎週N社
    // per-call 決済" evidence. Newest first, above the daily settlements.
    let sweepHtml = '';
    try {
      const swres = await fetch('/api/sweeps');
      if (swres.ok) {
        const sweeps = (await swres.json()).sweeps || [];
        sweepHtml = sweeps.map((s) => {
          const name = s.surface === 'edinet' ? 'EDINET 週次' : s.surface === 'catalyst' ? 'Catalyst 週次' : s.surface;
          const when = s.at ? new Date(s.at).toLocaleDateString('ja-JP') : '';
          const tx = s.sampleTx
            ? `<a class="settle__tx" href="${txUrl(s.sampleTx)}" target="_blank" rel="noopener">${esc(shortTx(s.sampleTx))}</a>`
            : '';
          return `
          <li class="settle__row settle__row--sweep">
            <div class="settle__head">
              <span class="settle__name">${esc(name)} <span class="settle__badge settle__badge--sweep">${s.settlements}件</span></span>
              <span class="settle__cost">${money(s.totalUsdc)}</span>
              ${tx}
            </div>
            <div class="settle__facts"><span>${s.settlements} settlements</span><span>${esc(when)}</span></div>
          </li>`;
        }).join('');
      }
    } catch { /* the sweep strip is additive — the list renders without it */ }

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
        const bad = r.status === 'degraded' || r.status === 'error';
        const badge = cooldown ? '休止' : r.status === 'degraded' ? '劣化' : r.status === 'error' ? '失敗' : '';
        const reason = r.status === 'degraded'
          ? (r.degradedReason || 'fallback data')
          : r.status === 'error' ? (r.error || 'failed') : '';
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
      // Sweeps first, then the day's endpoint settlements.
      settle.innerHTML = (sweepHtml + dailyHtml) || '<li class="settle__empty">No settlements yet.</li>';
    }
  } catch (e) {
    if (settle) settle.innerHTML = `<li class="settle__empty">Could not load run data (${esc(String(e))}).</li>`;
  }
}
loadRun();
setInterval(loadRun, 60000);

/* ── Weekly sweep detail (below the hero) ───────────────────────────────────
   Every company settled in the latest sweep, one row per per-call payment with
   its own tx. Paged so hundreds→thousands of rows stay light. */
const sweepState = { surface: null, week: null, offset: 0, total: 0, summaries: [] };

function selectSweep(surface) {
  const s = sweepState.summaries.find((x) => x.surface === surface);
  if (!s) return;
  sweepState.surface = surface;
  sweepState.week = s.week;
  sweepState.offset = 0;
  sweepState.total = s.settlements;
  document.querySelectorAll('#sweep-tabs .sweep__tab').forEach((b) =>
    b.setAttribute('aria-selected', b.dataset.surface === surface ? 'true' : 'false'));
  const name = surface === 'edinet' ? 'EDINET 週次' : surface === 'catalyst' ? 'Catalyst 週次' : surface;
  document.getElementById('sweep-title').textContent = name;
  document.getElementById('sweep-sub').textContent =
    `${s.week} · ${s.settlements}件 · ${money(s.totalUsdc)} · 社ごとに per-call 決済`;
  document.getElementById('sweep-list').innerHTML = '';
  loadSweepPage(true);
}

async function loadSweepPage(reset) {
  const list = document.getElementById('sweep-list');
  const more = document.getElementById('sweep-more');
  if (reset) sweepState.offset = 0;
  try {
    const url = `/api/sweeps/${encodeURIComponent(sweepState.surface)}/${encodeURIComponent(sweepState.week)}/items?offset=${sweepState.offset}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const page = await res.json();
    const start = page.offset || 0;
    const items = page.items || [];
    list.insertAdjacentHTML('beforeend', items.map((it, i) => {
      const idx = start + i + 1;
      const tx = it.tx
        ? `<a class="sweep__txlink" href="${txUrl(it.tx)}" target="_blank" rel="noopener">${esc(shortTx(it.tx))}</a>`
        : '<span class="sweep__txlink sweep__txlink--none">no tx</span>';
      const label = it.name ? `${esc(it.name)} (${esc(it.ticker)})` : (it.ticker ? esc(it.ticker) : '—');
      return `<li class="sweep__item"><span class="sweep__idx">#${idx}</span>` +
        `<span class="sweep__ticker">${label}</span>` +
        `<span class="sweep__amt">${money(it.amountUsdc)}</span>${tx}</li>`;
    }).join(''));
    sweepState.offset = start + items.length;
    sweepState.total = page.total || 0;
    if (more) more.hidden = sweepState.offset >= sweepState.total;
  } catch { if (more) more.hidden = true; }
}

async function loadSweepDetail() {
  const section = document.getElementById('sweep');
  if (!section) return;
  try {
    const res = await fetch('/api/sweeps');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const sweeps = (await res.json()).sweeps || [];
    if (!sweeps.length) { section.hidden = true; return; }
    section.hidden = false;
    sweepState.summaries = sweeps;
    const tabs = document.getElementById('sweep-tabs');
    tabs.innerHTML = sweeps.map((s) => {
      const label = s.surface === 'edinet' ? 'EDINET' : s.surface === 'catalyst' ? 'Catalyst' : s.surface;
      return `<button class="sweep__tab" role="tab" data-surface="${esc(s.surface)}">${esc(label)}</button>`;
    }).join('');
    tabs.querySelectorAll('.sweep__tab').forEach((b) =>
      b.addEventListener('click', () => selectSweep(b.dataset.surface)));
    selectSweep(sweeps[0].surface);   // newest sweep first
  } catch { section.hidden = true; }
}

document.getElementById('sweep-more')?.addEventListener('click', () => loadSweepPage(false));
loadSweepDetail();

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
