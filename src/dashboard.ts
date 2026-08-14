/**
 * Dashboard served by the agent's own HTTP server at `/`.
 *
 * The layout mirrors the official x402jp.com /products.html page one-to-one:
 * the same aurora background, the same liquid-glass endpoint groups (method /
 * path / status pill / price / description), and the same "これらを毎日叩いて
 * いるエージェント" block — except the "直近の稼働" run grid is populated live
 * from the agent's own /api/runs (real timestamps + on-chain tx links).
 *
 * The endpoint catalog (GROUPS) and the agent-block copy are taken verbatim
 * from the official page so the display matches exactly.
 */

type Ep = { method: string; path: string; free?: boolean; price?: string; desc: string };
type Group = { name: string; host?: string; note: string; eps: Ep[] };

// Verbatim from x402jp.com /products.html (ja).
const GROUPS: Group[] = [
  {
    name: "Japan Inflation Nowcast",
    host: "jin.x402jp.com",
    note: "決済は Solana USDC。discovery は /.well-known/x402.json。",
    eps: [
      { method: "GET", path: "/api/jin/latest", free: true, desc: "最新観測日の指数。観測値 + matched + 方法論。" },
      { method: "GET", path: "/api/jin/series", price: "$0.01", desc: "指数の時系列。機械向け。" },
      { method: "GET", path: "/api/jin/movers", price: "$0.02", desc: "その日動いた品目。特売タグ付き。機械向け。" },
    ],
  },
  {
    name: "Onchain Stock Data",
    host: "osd.x402jp.com",
    note: "決済は Base または Solana USDC。402が両方のチェーンを提示するので、クライアントがどちらかを選ぶ。",
    eps: [
      { method: "GET", path: "/api/alpha/portfolio/current", price: "$0.01", desc: "米国ポートフォリオ。現在の10銘柄と各社のthesis・判定期日。" },
      { method: "GET", path: "/api/alpha/portfolio/scorecard", price: "$0.01", desc: "米国の的中実績。hit / partial / miss と SPY・QQQ 比。" },
      { method: "GET", path: "/api/alpha/jp/portfolio/current", price: "$0.01", desc: "日本ポートフォリオ。現在の10銘柄。" },
      { method: "GET", path: "/api/alpha/jp/scorecard", price: "$0.01", desc: "日本の的中実績。ベンチマーク比。" },
      { method: "GET", path: "/api/alpha/jp/catalysts", price: "$0.01", desc: "日本株のカタリスト一覧。期日到来後に判定。" },
      { method: "GET", path: "/api/stocks/:ticker", price: "$0.01", desc: "銘柄データ。ticker指定。" },
    ],
  },
  {
    name: "Intelligence",
    note: "決済は Base USDC。",
    eps: [
      { method: "GET", path: "x402amd.vercel.app/api/macro/dashboard", price: "$0.30", desc: "APACマクロ。金利・為替・フロー・リスク regime。" },
      { method: "GET", path: "x402yi.vercel.app/api/yield/scan", price: "$0.20", desc: "DeFiの利回りスキャン。プール別のAPYとスマートマネー残高。" },
      { method: "POST", path: "x402pi.vercel.app/api/portfolio/analyze", price: "$0.50", desc: "ウォレットアドレスを渡すとポートフォリオを分析。" },
      { method: "GET", path: "x402-jrey.vercel.app/api/realestate/yield?area=tokyo", price: "$0.30", desc: "日本の不動産利回り。エリア指定。" },
      { method: "GET", path: "x402nansenpolymarket.vercel.app/api/divergence/scan", price: "$0.15", desc: "予測市場とオンチェーンフローの乖離スキャン。" },
      { method: "GET", path: "x402-hl.vercel.app/api/hyperliquid/scan", price: "$0.20", desc: "Hyperliquidの建玉・ファンディングとスマートマネーの偏り。" },
      { method: "GET", path: "smartmoneyscreener.vercel.app/api/screener/smart-money", price: "$0.05", desc: "スマートマネーが買っているトークンのスクリーニング。" },
      { method: "GET", path: "x402oif.vercel.app/api/feed/apac-daily", price: "$0.10", desc: "APACの日次オンチェーンサマリー。" },
      { method: "GET", path: "x402oif.vercel.app/api/feed/whale-alert", price: "$0.20", desc: "大口転送のアラート。" },
      { method: "GET", path: "odo-gamma.vercel.app/funding/nowcast/current", price: "$0.01", desc: "perpのファンディング・ナウキャスト。バスケット別。" },
    ],
  },
];

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Path used to match a catalog endpoint against the agent's actual run results. */
function pathKey(path: string): string {
  const noHost = path.startsWith("/") ? path : "/" + path.split("/").slice(1).join("/");
  return noHost.split("?")[0];
}

function renderEp(ep: Ep): string {
  const pill = ep.free
    ? '<span class="pill ok">200 ✓</span>'
    : '<span class="pill pay">402 ✓</span>';
  const price = ep.free ? "free" : esc(ep.price ?? "");
  const key = esc(pathKey(ep.path));
  return (
    '<div class="ep">' +
    '<div class="ep-top">' +
    '<code class="ep-code"><span class="m">' + esc(ep.method) + '</span> <span class="p">' + esc(ep.path) + "</span></code>" +
    pill +
    '<span class="price">' + price + "</span>" +
    '<span class="hit" data-key="' + key + '"></span>' +
    "</div>" +
    '<div class="ep-desc">' + esc(ep.desc) + "</div>" +
    "</div>"
  );
}

function renderGroup(g: Group): string {
  return (
    '<section class="grp glass">' +
    '<div class="grp-head">' +
    '<h3 class="grp-name">' + esc(g.name) + "</h3>" +
    (g.host ? '<code class="grp-host">host: ' + esc(g.host) + "</code>" : "") +
    "</div>" +
    '<div class="eps">' + g.eps.map(renderEp).join("") + "</div>" +
    '<p class="grp-note">' + esc(g.note) + "</p>" +
    "</section>"
  );
}

export function buildDashboardPage(): string {
  const agentId = process.env.ERC8004_AGENT_ID ?? "55560";
  const groupsHtml = GROUPS.map(renderGroup).join("");

  const clientJs = String.raw`
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money = (n) => "$" + (Number(n) || 0).toFixed(3);
const shortTx = (t) => t ? (t.slice(0, 8) + "…" + t.slice(-6)) : "";
const txUrl = (t) => t && t.startsWith("0x") ? "https://basescan.org/tx/" + t : "https://solscan.io/tx/" + t;
const fmtTs = (iso) => { try { return new Date(iso).toLocaleString("ja-JP"); } catch { return iso; } };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return r.json();
}

function pathOf(u) {
  try { return new URL(u.indexOf("://") >= 0 ? u : "https://" + u).pathname; } catch { return u || ""; }
}

// Fill each catalog row's right-hand "毎日 ✓" indicator from the agent's real runs.
function markHits(runs) {
  const hits = {};
  runs.forEach((run) => (run.results || []).forEach((r) => {
    if (!r.endpoint) return;
    const p = pathOf(r.endpoint);
    const prev = hits[p];
    if (!prev || new Date(run.timestamp) > new Date(prev.ts)) {
      hits[p] = { ts: run.timestamp, txHash: r.txHash, status: r.status };
    }
  }));
  document.querySelectorAll(".ep .hit").forEach((el) => {
    const key = el.getAttribute("data-key");
    let h = hits[key];
    if (!h && key.indexOf(":") >= 0) {
      const pre = key.slice(0, key.indexOf(":"));
      const k = Object.keys(hits).find((x) => x.indexOf(pre) === 0);
      if (k) h = hits[k];
    }
    if (h) {
      const tx = h.txHash
        ? '<a class="tx" href="' + txUrl(h.txHash) + '" target="_blank" rel="noopener">' + esc(shortTx(h.txHash)) + '</a>'
        : '';
      el.innerHTML = '<span class="chip-on">毎日 ✓</span>' + tx;
    } else {
      el.innerHTML = '<span class="miss">—</span>';
    }
  });
}

async function loadRun() {
  try {
    const res = await getJson("/api/runs?limit=40");
    const runs = res.runs || [];
    if (!runs.length) {
      $("#run-when").textContent = "—";
      $("#run-grid").innerHTML = '<p class="empty glass">まだ稼働記録がありません(次回 06:00 JST 以降)。</p>';
      return;
    }
    markHits(runs);
    const latest = runs.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    $("#run-when").textContent = fmtTs(latest.timestamp) + " JST";
    const cards = (latest.results || []).map((r) => {
      const tx = r.txHash
        ? '<a class="tx" href="' + txUrl(r.txHash) + '" target="_blank" rel="noopener">' + esc(shortTx(r.txHash)) + '</a>'
        : '<span class="notx">' + esc(r.status || "") + '</span>';
      return '<div class="run-card glass"><div class="rc-label">' + esc(r.product || r.endpoint) + '</div>'
        + '<div class="rc-detail">' + money(r.costUsdc) + ' · ' + tx + '</div></div>';
    }).join("");
    $("#run-grid").innerHTML = cards || '<p class="empty glass">—</p>';
    $("#run-spent").textContent = money(latest.totalCostUsdc);
    $("#updated").textContent = "updated " + new Date().toLocaleTimeString("ja-JP");
  } catch (e) {
    $("#run-grid").innerHTML = '<p class="empty glass">読み込み失敗: ' + esc(String(e)) + '</p>';
  }
}
loadRun();
setInterval(loadRun, 60000);
`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>x402 · Endpoints</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@300..600&family=Noto+Sans+JP:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --fg:255 255 255; --bg:12 12 12; --gold:232 195 56;
    --ink:rgb(var(--fg)); --gold-c:rgb(var(--gold)); --green:#28c840;
    --mono:"SF Mono","Menlo","Consolas",monospace;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; min-height:100vh; position:relative; background:rgb(var(--bg)); color:var(--ink);
    font-family:"Inter","Noto Sans JP",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  ::selection { background:rgba(61,129,227,.3); }
  a { color:inherit; }

  /* aurora background — matches the official light-beam field */
  .bg-fx { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; background:rgb(var(--bg)); }
  .bg-fx::before { content:""; position:absolute; inset:-30%;
    background:
      radial-gradient(60% 60% at 3% 2%, rgba(150,50,50,.30), transparent 55%),
      radial-gradient(65% 65% at 98% 98%, rgba(40,70,155,.32), transparent 55%),
      linear-gradient(118deg, transparent 22%, rgba(232,195,56,.30) 38%, rgba(150,215,170,.24) 52%, rgba(90,170,220,.24) 66%, transparent 82%);
    filter:blur(60px); animation:aurora 14s ease-in-out infinite; }
  @keyframes aurora { 0%,100%{transform:translate3d(-2%,-1%,0) rotate(0deg)} 50%{transform:translate3d(2%,1%,0) rotate(1.4deg)} }
  .bg-fx::after { content:""; position:absolute; inset:0;
    background:radial-gradient(140% 100% at 50% 50%, transparent 55%, rgba(0,0,0,.5)); }

  .wrap { position:relative; z-index:10; max-width:896px; margin:0 auto; padding:64px 24px 96px; }
  h1 { font-family:"Outfit",sans-serif; font-weight:700; font-size:38px; line-height:1.05; letter-spacing:-.02em; margin:0 0 12px; }
  .legend { font-size:12.5px; color:rgba(255,255,255,.55); line-height:1.6; margin:0 0 24px; }
  .legend .chip-on, .legend .miss { position:relative; top:-1px; }

  /* liquid glass */
  .glass { position:relative; background:rgba(255,255,255,.03);
    backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); border:none;
    box-shadow:inset 0 1px 1px rgba(255,255,255,.08); overflow:hidden; }
  .glass::before { content:""; position:absolute; inset:0; border-radius:inherit; padding:1.4px;
    background:linear-gradient(180deg, rgba(255,255,255,.4), rgba(255,255,255,.12) 22%,
      rgba(255,255,255,0) 42%, rgba(255,255,255,0) 60%, rgba(255,255,255,.12) 80%, rgba(255,255,255,.4));
    -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; }

  /* group card */
  .grp { border-radius:16px; padding:22px 24px; margin-bottom:18px; }
  .grp-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:6px; }
  .grp-name { font-family:"Outfit",sans-serif; font-weight:600; font-size:20px; margin:0; color:rgb(var(--fg)); }
  .grp-host { font-family:var(--mono); font-size:12px; color:rgba(255,255,255,.4); }
  .grp-note { font-size:12px; color:rgba(255,255,255,.5); line-height:1.6; margin:14px 0 0; }

  /* endpoint row */
  .ep { padding:13px 0; border-bottom:1px solid rgba(255,255,255,.1); }
  .ep:last-child { border-bottom:0; }
  .ep-top { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .ep-code { font-family:var(--mono); font-size:13.5px; letter-spacing:-.01em; }
  .ep-code .m { color:rgba(255,255,255,.4); }
  .ep-code .p { color:rgba(255,255,255,.9); }
  .pill { font-family:var(--mono); font-size:11px; padding:2px 8px; border-radius:6px; border:1px solid; }
  .pill.ok { color:var(--green); border-color:rgba(40,200,64,.5); background:rgba(40,200,64,.1); }
  .pill.pay { color:var(--gold-c); border-color:rgba(232,195,56,.5); background:rgba(232,195,56,.1); }
  .price { font-family:var(--mono); font-size:13px; font-weight:600; color:var(--gold-c); }
  .hit { margin-left:auto; display:inline-flex; align-items:center; gap:8px; }
  .chip-on { font-family:var(--mono); font-size:11px; color:var(--green); border:1px solid rgba(40,200,64,.5); background:rgba(40,200,64,.1); padding:2px 8px; border-radius:6px; white-space:nowrap; }
  .miss { font-family:var(--mono); font-size:12px; color:rgba(255,255,255,.28); }
  .ep-desc { font-size:13px; color:rgba(255,255,255,.5); line-height:1.6; margin-top:6px; }

  /* agent block */
  .agent { margin-top:56px; }
  .agent-h { font-family:"Outfit",sans-serif; font-weight:600; font-size:28px; letter-spacing:-.01em; margin:0 0 16px; }
  .agent-desc { font-size:14px; color:rgba(255,255,255,.7); line-height:1.75; margin:0 0 6px; max-width:680px; }
  .run-head { font-family:var(--mono); font-size:12px; letter-spacing:.06em; color:rgba(255,255,255,.4); margin:26px 0 12px; }
  .run-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
  .run-card { border-radius:12px; padding:14px 16px; }
  .rc-label { font-size:13px; font-weight:500; color:rgba(255,255,255,.9); line-height:1.4; }
  .rc-detail { font-family:var(--mono); font-size:12px; color:rgba(255,255,255,.55); margin-top:7px; }
  a.tx { color:var(--gold-c); text-decoration:none; }
  a.tx:hover { text-decoration:underline; }
  .notx { color:rgba(255,255,255,.4); }
  .agent-note { font-size:12px; color:rgba(255,255,255,.5); line-height:1.7; margin:18px 0 0; max-width:680px; }
  .empty { color:rgba(255,255,255,.5); font-size:13px; border-radius:12px; padding:18px; grid-column:1 / -1; }

  .foot { color:rgba(255,255,255,.4); font-size:12px; margin-top:34px; padding-top:16px; border-top:1px solid rgba(255,255,255,.1); }
  .foot a { color:var(--gold-c); text-decoration:none; } .foot a:hover { text-decoration:underline; }
  #updated { float:right; font-family:var(--mono); }

  @media (max-width:640px){ h1{font-size:30px} .run-grid{grid-template-columns:1fr} .agent-h{font-size:23px} }
</style>
</head>
<body>
  <div class="bg-fx"></div>
  <div class="wrap">
    <h1>Endpoints</h1>
    <p class="legend">各行の右端 <span class="chip-on">毎日 ✓</span> は、自律エージェント(AA)が直近の稼働で実際に叩いた(＝オンチェーン決済した)エンドポイント。<span class="miss">—</span> は直近では未取得。</p>
    ${groupsHtml}

    <section class="agent">
      <h2 class="agent-h">これらを毎日叩いているエージェント</h2>
      <p class="agent-desc">当社の自律エージェント(AA)は、Base mainnet上のオンチェーンidentity(ERC-8004、agentId ${agentId})を持ち、毎日06:00 JSTに上記のエンドポイントを叩いて、1コールずつUSDCで決済している。決済の署名は Circle Developer-Controlled Wallet が行う。</p>
      <div class="run-head">直近の稼働(<span id="run-when">…</span>) · 決済 <span id="run-spent">–</span></div>
      <div id="run-grid" class="run-grid"><p class="empty glass">読み込み中…</p></div>
      <p class="agent-note">支払いはすべてオンチェーンに記録され、Basescan / Solscan で検証できる。同じエンドポイントは、誰でも同じ手順で叩ける。</p>
      <p class="foot">Served by the agent on Railway · data from Upstash · <a href="https://x402jp.com" target="_blank" rel="noopener">x402jp.com</a><span id="updated"></span></p>
    </section>
  </div>
  <script>${clientJs}</script>
</body>
</html>`;
}
