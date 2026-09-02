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
    document.getElementById('stat-spend').textContent = money(spend);
    document.getElementById('stat-tx').textContent = paid.length;
    document.getElementById('stat-ok').textContent =
      results.filter((r) => r.status === 'success').length + '/' + results.length;

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

      settle.innerHTML = paid.map((r) => {
        const facts = factsByPath.get(pathOf(r.endpoint || '')) || [];
        const line = facts.length
          ? `<div class="settle__facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>`
          : (r.responsePeek ? `<div class="settle__facts settle__facts--raw">${esc(String(r.responsePeek).slice(0, 70))}</div>` : '');
        return `
        <li class="settle__row">
          <div class="settle__head">
            <span class="settle__name">${esc(r.product || r.endpoint)}</span>
            <span class="settle__cost">${money(r.costUsdc)}</span>
            <a class="settle__tx" href="${txUrl(r.txHash)}" target="_blank" rel="noopener">${esc(shortTx(r.txHash))}</a>
          </div>
          ${line}
        </li>`;
      }).join('') || '<li class="settle__empty">No settlements in the latest run.</li>';
    }
  } catch (e) {
    if (settle) settle.innerHTML = `<li class="settle__empty">Could not load run data (${esc(String(e))}).</li>`;
  }
}
loadRun();
setInterval(loadRun, 60000);

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
