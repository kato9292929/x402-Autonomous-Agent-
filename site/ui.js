/** Menu, endpoints overlay, and the live "latest run" card. */

/* ── Endpoint catalog ──────────────────────────────────────────────────────
   Hosts are the x402jp.com custom domains. Prices and descriptions match the
   published catalog on x402jp.com/products.html. `daily` marks the endpoints
   this agent calls on its 06:00 JST schedule. */
const GROUPS = [
  {
    name: 'Japan Inflation Nowcast',
    host: 'jin.x402jp.com',
    note: '決済は Solana USDC。discovery は /.well-known/x402.json。',
    eps: [
      { method: 'GET', path: '/api/jin/latest', free: true, daily: true, desc: '最新観測日の指数。観測値 + matched + 方法論。' },
      { method: 'GET', path: '/api/jin/series', price: '$0.01', desc: '指数の時系列。機械向け。' },
      { method: 'GET', path: '/api/jin/movers', price: '$0.02', daily: true, desc: 'その日動いた品目。特売タグ付き。機械向け。' },
    ],
  },
  {
    name: 'Onchain Stock Data',
    host: 'osd.x402jp.com',
    note: '決済は Base または Solana USDC。402が両方のチェーンを提示するので、クライアントがどちらかを選ぶ。',
    eps: [
      { method: 'GET', path: '/api/alpha/portfolio/current', price: '$0.01', daily: true, desc: '米国ポートフォリオ。現在の10銘柄と各社のthesis・判定期日。' },
      { method: 'GET', path: '/api/alpha/portfolio/scorecard', price: '$0.01', daily: true, desc: '米国の的中実績。hit / partial / miss と SPY・QQQ 比。' },
      { method: 'GET', path: '/api/alpha/jp/portfolio/current', price: '$0.01', daily: true, desc: '日本ポートフォリオ。現在の10銘柄。' },
      { method: 'GET', path: '/api/alpha/jp/scorecard', price: '$0.01', daily: true, desc: '日本の的中実績。ベンチマーク比。' },
      { method: 'GET', path: '/api/alpha/jp/catalysts', price: '$0.01', daily: true, desc: '日本株のカタリスト一覧。期日到来後に判定。' },
      { method: 'GET', path: '/api/stocks/:ticker', price: '$0.01', desc: '銘柄データ。ticker指定。' },
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
      { method: 'GET', path: 'x402-hl.vercel.app/api/hyperliquid/scan', price: '$0.20', daily: true, desc: 'Hyperliquidの建玉・ファンディングとスマートマネーの偏り。' },
      { method: 'GET', path: 'smartmoneyscreener.vercel.app/api/screener/smart-money', price: '$0.05', daily: true, desc: 'スマートマネーが買っているトークンのスクリーニング。' },
      { method: 'GET', path: 'x402oif.vercel.app/api/feed/apac-daily', price: '$0.10', daily: true, desc: 'APACの日次オンチェーンサマリー。' },
      { method: 'GET', path: 'x402oif.vercel.app/api/feed/whale-alert', price: '$0.20', daily: true, desc: '大口転送のアラート。' },
      { method: 'GET', path: 'odo-gamma.vercel.app/funding/nowcast/current', price: '$0.01', daily: true, desc: 'perpのファンディング・ナウキャスト。バスケット別。' },
    ],
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderGroups() {
  const host = document.getElementById('groups');
  if (!host) return;
  host.innerHTML = GROUPS.map((g) => {
    const rows = g.eps.map((ep) => `
      <div class="ep">
        <div class="ep__top">
          <code class="ep__code"><span class="ep__m">${esc(ep.method)}</span> <span class="ep__p">${esc(ep.path)}</span></code>
          <span class="pill ${ep.free ? 'pill--ok' : 'pill--pay'}">${ep.free ? '200' : '402'}</span>
          <span class="ep__price">${ep.free ? 'free' : esc(ep.price)}</span>
          ${ep.daily ? '<span class="chip-on">daily ✓</span>' : '<span class="chip-off">—</span>'}
        </div>
        <p class="ep__desc">${esc(ep.desc)}</p>
      </div>`).join('');
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

/* ── Live "latest run" card ─────────────────────────────────────────────── */
const money = (n) => '$' + (Number(n) || 0).toFixed(3);
const shortTx = (t) => (t ? t.slice(0, 6) + '…' + t.slice(-4) : '');
const txUrl = (t) => (t && t.startsWith('0x') ? 'https://basescan.org/tx/' + t : 'https://solscan.io/tx/' + t);

async function loadRun() {
  const settle = document.getElementById('settle');
  try {
    const res = await fetch('/api/runs?limit=40');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const runs = (await res.json()).runs || [];
    // Only the data-fetching runs; Mode A carries no endpoint results.
    const shown = runs.filter((r) => r.mode === 'B' || r.mode === 'D');
    if (!shown.length) {
      if (settle) settle.innerHTML = '<li class="settle__empty">No runs recorded yet.</li>';
      return;
    }
    const latest = shown.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    const results = latest.results || [];
    const paid = results.filter((r) => r.txHash);

    document.getElementById('run-when').textContent =
      new Date(latest.timestamp).toLocaleDateString('ja-JP');
    document.getElementById('stat-spend').textContent = money(latest.totalCostUsdc);
    document.getElementById('stat-tx').textContent = paid.length;
    document.getElementById('stat-ok').textContent =
      results.filter((r) => r.status === 'success').length + '/' + results.length;

    if (settle) {
      settle.innerHTML = paid.slice(0, 3).map((r) => `
        <li class="settle__row">
          <span class="settle__name">${esc(r.product || r.endpoint)}</span>
          <a class="settle__tx" href="${txUrl(r.txHash)}" target="_blank" rel="noopener">${esc(shortTx(r.txHash))}</a>
        </li>`).join('') || '<li class="settle__empty">No settlements in the latest run.</li>';
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

function setSheet(open) {
  if (!sheet || !sheetOpen) return;
  sheet.classList.toggle('is-open', open);
  sheetOpen.setAttribute('aria-expanded', String(open));
  if (open) sheetClose?.focus({ preventScroll: true });
  else sheetOpen.focus({ preventScroll: true });
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
