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

/** Stats row of a panel, in the Latest run card's markup. */
function setStats(id, stats) {
  document.getElementById(id).innerHTML = stats.map(([n, l]) =>
    `<div class="stat"><span class="stat__n">${esc(n)}</span><span class="stat__l">${esc(l)}</span></div>`).join('');
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
/** 百万円の表示。null/未取得は「—」(0で埋めない)。 */
const fmtM = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('ja-JP'));
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
      // The weekly sweeps have their own cards; this one is the daily run only.
      settle.innerHTML = dailyHtml || '<li class="settle__empty">No settlements yet.</li>';
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
      // 財務(百万円)は実値があるときだけ。financials_available:false は正直に出す。
      const hasFin = it.salesM != null || it.operatingIncomeM != null;
      const line = hasFin
        ? facts([`売上 ${fmtM(it.salesM)}`, `営利 ${fmtM(it.operatingIncomeM)}`, '百万円'])
        : it.financialsAvailable === false
          ? '<div class="settle__facts settle__facts--raw">書類は特定・財務は未取得</div>'
          : '';
      return row({ name: `<span class="settle__idx">#${start + i + 1}</span> ${esc(label)}`, cost: money(it.amountUsdc), tx: txLink(it.tx), line });
    }).join(''));
    edinet.offset = start + items.length;
    edinet.total = page.total || 0;
    if (edinet.offset < edinet.total) list.insertAdjacentHTML('beforeend', `<li class="settle__empty settle__more">${edinet.offset}/${edinet.total}件 — スクロールで続きを読み込む</li>`);
    else list.insertAdjacentHTML('beforeend', note('EDINET の全提出者 約4,000社のうち、今週 AA が per-call で実決済した社。各 per-call は最新の有報／四半期報告書の実財務(売上・営業利益・純利益、生JPY)を返す。株価は含まない。出典：金融庁 EDINET。'));
  } catch (e) {
    list.insertAdjacentHTML('beforeend', empty(`読み込めなかった (${e})`));
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
    const s = ((await res.json()).sweeps || []).find((x) => x.surface === 'edinet');
    if (!s) { list.innerHTML = empty('まだ記録がない。'); return; }
    document.getElementById('edinet-when').textContent = [s.week, shortDate(s.at)].filter(Boolean).join(' · ');
    setStats('edinet-stats', [[money(s.totalUsdc), 'USDC spent'], [String(s.settlements ?? '—'), 'Settlements']]);
    list.innerHTML = '';
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

async function loadProbe() {
  const list = document.getElementById('probe-list');
  if (!list) return;
  try {
    const res = await fetch('/api/probes?limit=12');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    sellerNames = payload.targets || {};
    // The newest PAID run; a discovery run settles nothing.
    const run = (payload.probes || []).find((r) => r.mode === 'sweep');
    if (!run) { list.innerHTML = empty('まだ記録がない。'); return; }
    const rows = run.records || [];
    const paid = rows.filter((r) => r.outcome === 'paid');
    const sellers = new Set(paid.map((r) => r.target));
    document.getElementById('probe-when').textContent = [run.week, shortDate(run.at)].filter(Boolean).join(' · ');
    setStats('probe-stats', [[money(run.runSpentUsdc), 'USDC spent'], [String(sellers.size), 'Sellers'], [`${paid.length}/${rows.length}`, 'Paid']]);

    const bySeller = (run.summaries || []).map((s) => row({
      name: esc(sellerName(s.target)),
      badge: `成功 ${Math.round((s.successRate || 0) * 100)}%`, badgeOk: true,
      cost: s.paidCalls > 0 ? money6(s.measuredPerCallUsdc) + '/call' : '—',
      line: facts([`${s.paidCalls}/${s.calls} 決済`, s.skipped && `${s.skipped} skip`, s.errors && `${s.errors} err`]),
    })).join('');
    const calls = rows.map((r) => {
      const ok = r.outcome === 'paid';
      return row({
        name: `${esc(sellerName(r.target))} <code class="settle__path">${esc(r.path)}</code>`,
        badge: ok ? '' : r.outcome, bad: !ok,
        cost: `${money6(r.quotedUsdc)} → ${money6(r.actualUsdc)}`,
        tx: txLink(r.txHash),
        line: ok ? facts([chainLabel(r.chain), r.latencyMs != null && `${r.latencyMs}ms`]) : (r.reason ? reason(r.reason) : ''),
      });
    }).join('');
    list.innerHTML = group('売り手別') + bySeller + group('コール別 · 提示 → 実課金') + calls +
      note('自社の外にある第三者の x402 売り手に週1回支払い、実費と内容を測っている。提示額は売り手の 402 から、実課金は決済レスポンスから取る。');
  } catch (e) { list.innerHTML = empty(`Could not load (${e})`); }
}
loadProbe();

/* Arcium MXE: the five sealed functions. Where the computation ran (Arcium)
   and where a payment settled (Solana mainnet) are shown apart. */
const compUrl = (a, net) =>
  'https://explorer.solana.com/address/' + a + (net === 'arcium-devnet' ? '?cluster=devnet' : '');
const ms = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ja-JP') + 'ms');
const usd = (n) => (n == null ? '—' : '$' + Number(n).toFixed(6));
const netLabel = (n) => ({ 'arcium-devnet': 'devnet', 'arcium-mainnet': 'mainnet', 'arcium-localnet': 'localnet' }[n] || n || '—');
const partyLabel = (c) => ({ internal: '内部取引', self: '自己', external: '外部' }[c] || c);

function mxeResult(r) {
  const x = r.result || {};
  switch (r.fn) {
    case 1: return x.matched ? `成立 ${usd(Number(x.priceMicro) / 1e6)}` : '不成立';
    case 2: return x.winner ? `落札 ${shortTx(x.winner)} ${usd(Number(x.priceMicro) / 1e6)}` : '';
    case 3: return x.ratingCount != null ? `評価 ${x.ratingCount}件(集計のみ公開)` : '';
    case 4: return x.reached === undefined ? '' : x.reached ? `到達(${x.participants}者)` : '未到達・誰も払わない';
    case 5: return x.catalogSize ? `N=${x.catalogSize} 一致 ${(x.matches || []).length}件` : '';
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
    if (!p.total) { list.innerHTML = empty('まだ記録がない。'); return; }

    const latest = new Map();
    for (const r of records) if (!latest.has(r.fn)) latest.set(r.fn, r);
    const okFns = [...latest.values()].filter((r) => r.status === 'ok').length;
    const okRuns = p.aggregates.reduce((a, g) => a + g.ok, 0);
    const pays = records.reduce((a, r) => a + (r.paymentTxs || []).length, 0);
    document.getElementById('mxe-when').textContent = records[0] ? shortDate(records[0].at) : '—';
    setStats('mxe-stats', [[`${okFns}/5`, 'Functions'], [String(okRuns), 'Runs'], [String(pays), 'Payments']]);

    const byFn = p.aggregates.map((g) => {
      const f = p.functions.find((x) => x.fn === g.fn) || {};
      // The newest run of the function decides the badge; the totals follow.
      const last = latest.get(g.fn);
      const lastOk = last && last.status === 'ok';
      return row({
        name: `${g.fn}. ${esc(g.label)}`,
        badge: f.enabled === false ? '無効' : !last ? '記録なし' : lastOk ? '成功' : '失敗',
        badgeOk: f.enabled !== false && lastOk, bad: last && !lastOk,
        cost: usd(g.costUsd && g.costUsd.mean),
        line: facts([
          `${g.ok}/${g.runs} 成功`,
          `平均 ${ms(g.latencyMs && g.latencyMs.mean)}`,
          g.unitCostRatio && `単価比 ${g.unitCostRatio.mean.toFixed(2)}`,
          g.compared && `比較 ${g.compared}`,
          g.networks.length && g.networks.map(netLabel).join('/'),
        ]),
      });
    }).join('');
    const recs = records.map((r) => {
      const ok = r.status === 'ok';
      const comp = r.computationAccount
        ? `<a class="settle__tx" href="${compUrl(r.computationAccount, r.network)}" target="_blank" rel="noopener">計算</a>`
        : '<span class="settle__tx settle__tx--none">計算なし</span>';
      const payLinks = (r.paymentTxs || []).map((t) => txLink(t, '支払')).join('');
      const line = ok
        ? facts([netLabel(r.network) + (r.paymentNetwork ? ' → Solana' : ''), ms(r.latencyMs), partyLabel(r.counterparty),
            r.unitCostRatio != null && `単価比 ${r.unitCostRatio.toFixed(2)}`,
            r.comparison && `比較(${r.comparison.method}) ${JSON.stringify(r.comparison.result)}`])
        : reason(r.error || 'failed');
      return row({
        name: `#${r.fn} ${esc(mxeResult(r) || '—')}`, badge: ok ? '' : '失敗', bad: !ok,
        cost: `${shortDate(r.at)} · ${usd(r.costUsd)}`, tx: comp + payLinks, line,
      });
    }).join('');
    list.innerHTML = group('機能別 · 平均') + byFn + group('記録 · 新しい順') + recs +
      note('判定は Arcium のクラスタ、支払いは x402 で Solana mainnet。機能1・2・4 の相手方は AA 自身の内部エージェントで、外部需要の証拠ではない。devnet の SOL に市場価格はないため、USD は mainnet の SOL/USD で換算した目安。' +
        (p.jobEnabled ? ' 毎日 07:30 JST に実行。' : ' 定時実行は停止中。'));
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
