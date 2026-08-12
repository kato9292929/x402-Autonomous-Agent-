/**
 * Self-contained HTML dashboard, served by the agent's own HTTP server at `/`.
 * It fetches /api/runs and /api/decisions (same origin) and renders the daily
 * records — Mode B/A/D/C run summaries, per-endpoint status, spend, and the
 * on-chain settlement tx for each paid call (linked to Solscan / Basescan).
 *
 * No build step, no framework, no external JS. Google Fonts are fine here (the
 * page is served over plain HTTP by the agent, not inside a CSP-restricted host).
 */
export function buildDashboardPage(): string {
  const agentId = process.env.ERC8004_AGENT_ID ?? "55560";
  // Client script kept as a plain string so no bundler is needed.
  const clientJs = String.raw`
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money = (n) => "$" + (Number(n) || 0).toFixed(3);
const shortTx = (t) => t ? (t.slice(0, 8) + "…" + t.slice(-6)) : "";
// Base tx = 0x-hex (Basescan); otherwise base58 Solana signature (Solscan).
const txUrl = (t) => t && t.startsWith("0x")
  ? "https://basescan.org/tx/" + t
  : "https://solscan.io/tx/" + t;
const fmtTs = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const statusIcon = (s) => s === "success" ? "✓" : s === "degraded" ? "≈" : "✗";
const statusClass = (s) => s === "success" ? "ok" : s === "degraded" ? "deg" : "err";
const modeLabel = { A: "Decision", B: "Briefing", C: "Weekly", D: "Alpha" };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return r.json();
}

function renderDecisions(decisions) {
  if (!decisions.length) return '<p class="empty glass">No Mode A decisions recorded yet.</p>';
  // BUY first, then SKIP — never lead with SKIP. Stable sort keeps newest-first within each group.
  const ordered = decisions.slice().sort((a, b) => {
    const ab = (a.call && a.call.action) === "BUY" ? 0 : 1;
    const bb = (b.call && b.call.action) === "BUY" ? 0 : 1;
    return ab - bb;
  });
  return ordered.map((d) => {
    const c = d.call || {};
    const act = c.action || "—";
    const badge = act === "BUY" ? "buy" : "skip";
    return '<div class="dcard glass">'
      + '<div class="drow"><span class="dbadge ' + badge + '">' + esc(act) + '</span>'
      + '<span class="ddir">' + esc(c.direction || "") + '</span>'
      + '<span class="dscore">score ' + esc((d.score ?? 0).toFixed ? d.score.toFixed(2) : d.score) + '</span>'
      + '<span class="dwhen">' + esc(d.date || fmtTs(d.timestamp)) + '</span></div>'
      + '<div class="drat">' + esc(d.rationale || "") + '</div>'
      + '<div class="dmeta">size proposal ' + money(c.sizeUsdProposal) + ' · spent ' + money(d.costUsdc) + ' · executed: ' + esc(String(d.executed)) + '</div>'
      + '</div>';
  }).join("");
}

function renderRun(run) {
  const results = run.results || [];
  const ok = results.filter((r) => r.status === "success").length;
  const deg = run.totalDegradedCount ?? results.filter((r) => r.status === "degraded").length;
  const err = (run.errors || []).length || results.filter((r) => r.status === "error").length;
  const rows = results.map((r) => {
    const tx = r.txHash
      ? '<a class="tx" href="' + txUrl(r.txHash) + '" target="_blank" rel="noopener">' + esc(shortTx(r.txHash)) + '</a>'
      : '<span class="notx">—</span>';
    const note = r.status === "error" ? (r.error || "") : (r.degradedReason || r.responsePeek || "");
    return '<tr class="' + statusClass(r.status) + '">'
      + '<td class="st">' + statusIcon(r.status) + '</td>'
      + '<td class="pd">' + esc(r.product || r.endpoint) + '</td>'
      + '<td class="co">' + money(r.costUsdc) + '</td>'
      + '<td class="tc">' + tx + '</td>'
      + '<td class="nt">' + esc(String(note).slice(0, 90)) + '</td>'
      + '</tr>';
  }).join("");
  return '<section class="run glass">'
    + '<header class="rhead">'
    + '<span class="mbadge m' + esc(run.mode) + '">Mode ' + esc(run.mode) + '</span>'
    + '<span class="mname">' + esc(modeLabel[run.mode] || "") + '</span>'
    + '<span class="rwhen">' + esc(fmtTs(run.timestamp)) + '</span>'
    + '<span class="rtot"><b class="ok">' + ok + '</b> ok · <b class="deg">' + deg + '</b> degraded · <b class="err">' + err + '</b> err</span>'
    + '<span class="rspend">' + money(run.totalCostUsdc) + '</span>'
    + '</header>'
    + '<table class="rtbl"><tbody>' + rows + '</tbody></table>'
    + '</section>';
}

async function load() {
  try {
    const [runsRes, decRes] = await Promise.all([
      getJson("/api/runs?limit=40"),
      getJson("/api/decisions").catch(() => ({ decisions: [] })),
    ]);
    const runs = runsRes.runs || [];
    const spend = runs.reduce((a, r) => a + (Number(r.totalCostUsdc) || 0), 0);
    const txs = runs.reduce((a, r) => a + (r.results || []).filter((x) => x.txHash).length, 0);
    $("#stat-runs").textContent = runs.length;
    $("#stat-spend").textContent = money(spend);
    $("#stat-tx").textContent = txs;
    $("#decisions").innerHTML = renderDecisions(decRes.decisions || []);
    $("#runs").innerHTML = runs.length ? runs.map(renderRun).join("") : '<p class="empty glass">No runs recorded yet. They appear after the next daily run (06:00 JST).</p>';
    $("#updated").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("#runs").innerHTML = '<p class="empty glass">Could not load records: ' + esc(String(e)) + '</p>';
  }
}
load();
setInterval(load, 60000);
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>x402 Agent — Daily Records</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@300..600&family=Noto+Sans+JP:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --fg:255 255 255; --bg:12 12 12; --gold:232 195 56;
    --ink:rgb(var(--fg)); --muted:rgba(255,255,255,.56); --soft:rgba(255,255,255,.80);
    --line:rgba(255,255,255,.10); --goldc:rgb(var(--gold)); --goldsoft:rgba(232,195,56,.55);
    --mono:"SF Mono","Menlo","Consolas",monospace;
    --ok:#5fd08a; --deg:#E8C338; --err:#f2777a;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; min-height:100vh; position:relative; background:rgb(var(--bg)); color:var(--ink);
    font-family:"Inter","Noto Sans JP",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  ::selection { background:rgba(61,129,227,.3); }
  a { color:inherit; }

  /* fixed background field (z-0) — pastel/gold glow, blurred */
  .bg-fx { position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden; }
  .bg-fx::before { content:""; position:absolute; inset:-25%;
    background:
      radial-gradient(50% 42% at 82% 2%, rgba(232,195,56,.24), transparent 60%),
      radial-gradient(46% 38% at 6% 16%, rgba(61,129,227,.18), transparent 60%),
      radial-gradient(62% 56% at 55% 116%, rgba(232,195,56,.14), transparent 62%);
    filter:blur(42px); }
  .bg-fx::after { content:""; position:absolute; inset:0;
    background:radial-gradient(135% 95% at 50% -14%, transparent 46%, rgba(0,0,0,.5)); }

  .wrap { position:relative; z-index:10; max-width:1000px; margin:0 auto; padding:60px 20px 96px; }

  /* liquid glass (the signature card) */
  .glass { position:relative; background:rgba(255,255,255,.03);
    backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); border:none;
    box-shadow:inset 0 1px 1px rgba(255,255,255,.08); overflow:hidden; }
  .glass::before { content:""; position:absolute; inset:0; border-radius:inherit; padding:1.4px;
    background:linear-gradient(180deg, rgba(255,255,255,.45), rgba(255,255,255,.14) 20%,
      rgba(255,255,255,0) 40%, rgba(255,255,255,0) 60%, rgba(255,255,255,.14) 80%, rgba(255,255,255,.45));
    -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none; }

  /* header */
  .eyebrow { display:inline-block; font-family:"Outfit",sans-serif; font-size:12px; font-weight:600;
    letter-spacing:.18em; text-transform:uppercase; margin:0 0 16px;
    background-image:linear-gradient(to right,#6B5310,#A67C10 12.5%,#FDF6D0 32.5%,#E8C338 50%,#A67C10 67.5%,#6B5310 87.5%,#6B5310);
    background-size:200% auto; -webkit-background-clip:text; background-clip:text; color:transparent;
    -webkit-text-fill-color:transparent; animation:shiny 6s linear infinite; }
  @keyframes shiny { to { background-position:200% center; } }
  h1 { font-family:"Outfit",sans-serif; font-weight:700; font-size:56px; line-height:1.0; letter-spacing:-.02em; margin:0 0 14px;
    background-image:linear-gradient(to right,#6B5310,#A67C10 12.5%,#FDF6D0 32.5%,#E8C338 50%,#A67C10 67.5%,#6B5310 87.5%,#6B5310);
    background-size:200% auto; -webkit-background-clip:text; background-clip:text; color:transparent;
    -webkit-text-fill-color:transparent; animation:shiny 8s linear infinite; }
  .sub { color:var(--muted); font-size:15px; line-height:1.65; margin:0 0 36px; max-width:640px; }
  .sub b { color:var(--ink); font-weight:500; }

  /* stats */
  .stats { display:flex; gap:14px; flex-wrap:wrap; margin:0 0 46px; }
  .stat { border-radius:18px; padding:18px 22px; min-width:150px; flex:1 1 auto; }
  .stat .n { font-family:"Outfit",sans-serif; font-weight:700; font-size:32px; line-height:1; color:var(--goldc); font-variant-numeric:tabular-nums; }
  .stat .l { color:var(--muted); font-size:10.5px; margin-top:10px; letter-spacing:.09em; text-transform:uppercase; font-family:var(--mono); }

  /* section head with gold chip */
  .sec-head { display:flex; align-items:center; gap:12px; margin:46px 0 16px; }
  h2 { font-family:"Outfit",sans-serif; font-weight:600; font-size:22px; letter-spacing:-.01em; margin:0; }
  .chip { font-family:var(--mono); font-size:11px; letter-spacing:.04em; color:var(--goldc);
    border:1px solid var(--goldsoft); background:rgba(232,195,56,.08); padding:3px 9px; border-radius:999px; }
  .empty { color:var(--muted); font-size:14px; border-radius:16px; padding:22px; }

  /* decisions */
  .dcard { border-radius:16px; padding:16px 18px; margin-bottom:11px; transition:transform .18s ease, box-shadow .18s ease; }
  .dcard:hover { transform:translateY(-2px); box-shadow:0 10px 34px rgba(0,0,0,.4), inset 0 1px 1px rgba(255,255,255,.1); }
  .drow { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .dbadge { font-family:var(--mono); font-size:11.5px; font-weight:600; padding:3px 11px; border-radius:999px; letter-spacing:.03em; }
  .dbadge.buy { background:rgba(95,208,138,.16); color:var(--ok); } .dbadge.skip { background:rgba(255,255,255,.08); color:var(--muted); }
  .ddir { font-size:13px; color:var(--muted); } .dscore { font-size:13px; color:var(--goldc); font-variant-numeric:tabular-nums; }
  .dwhen { margin-left:auto; font-size:12px; color:var(--muted); font-family:var(--mono); }
  .drat { font-size:13.5px; margin-top:10px; color:var(--soft); line-height:1.55; }
  .dmeta { font-size:12px; color:var(--muted); margin-top:8px; }

  /* runs */
  .run { border-radius:18px; padding:6px 6px 8px; margin-bottom:15px; transition:transform .18s ease, box-shadow .18s ease; }
  .run:hover { transform:translateY(-2px); box-shadow:0 10px 34px rgba(0,0,0,.4), inset 0 1px 1px rgba(255,255,255,.1); }
  .rhead { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:14px 16px 12px; }
  .mbadge { font-family:"Outfit",sans-serif; font-size:11.5px; font-weight:600; padding:3px 10px; border-radius:9px; background:rgba(255,255,255,.07); color:var(--soft); letter-spacing:.02em; }
  .mB{background:rgba(61,129,227,.18);color:#8fbaff}.mA{background:rgba(180,130,220,.18);color:#cba3e8}.mD{background:rgba(95,208,138,.16);color:var(--ok)}.mC{background:rgba(232,195,56,.18);color:var(--goldc)}
  .mname { font-size:13px; color:var(--muted); }
  .rwhen { font-size:12px; color:var(--muted); font-family:var(--mono); }
  .rtot { margin-left:auto; font-size:12.5px; color:var(--muted); }
  .rtot .ok{color:var(--ok)}.rtot .deg{color:var(--deg)}.rtot .err{color:var(--err)}
  .rspend { font-size:13px; font-variant-numeric:tabular-nums; color:var(--goldc); font-family:var(--mono); }
  table.rtbl { width:100%; border-collapse:collapse; }
  .rtbl td { padding:9px 12px; font-size:13px; border-top:1px solid var(--line); vertical-align:top; }
  .rtbl .st { width:22px; text-align:center; font-weight:700; }
  .rtbl tr.ok .st{color:var(--ok)}.rtbl tr.deg .st{color:var(--deg)}.rtbl tr.err .st{color:var(--err)}
  .rtbl .pd { font-weight:500; color:rgba(255,255,255,.9); }
  .rtbl .co { width:66px; color:var(--muted); font-variant-numeric:tabular-nums; font-family:var(--mono); }
  .rtbl .tc { width:152px; }
  .rtbl .nt { color:var(--muted); font-size:12px; }
  a.tx { color:var(--goldc); text-decoration:none; font-variant-numeric:tabular-nums; font-family:var(--mono); }
  a.tx:hover { text-decoration:underline; }
  .notx { color:rgba(255,255,255,.2); }

  .foot { color:var(--muted); font-size:12px; margin-top:36px; padding-top:18px; border-top:1px solid var(--line); }
  .foot a { color:var(--goldc); text-decoration:none; } .foot a:hover { text-decoration:underline; }
  #updated { float:right; font-family:var(--mono); }

  /* one-time load reveal (shell only — dynamic cards never re-animate) */
  @keyframes rise { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:none; } }
  .rise { opacity:0; animation:rise .6s cubic-bezier(.22,1,.36,1) forwards; }
  .rise.d1{animation-delay:.06s}.rise.d2{animation-delay:.13s}.rise.d3{animation-delay:.21s}.rise.d4{animation-delay:.3s}
  @media (max-width:560px){ h1{font-size:40px} .stat{flex:1 1 40%; min-width:0} }
</style>
</head>
<body>
  <div class="bg-fx"></div>
  <div class="wrap">
    <div class="eyebrow rise">x402 · Autonomous Agent</div>
    <h1 class="rise d1">Daily records</h1>
    <p class="sub rise d1">On-chain record of what the <b>x402 autonomous agent</b> (ERC-8004 agentId <b>${agentId}</b>) paid for and decided, each day. Every paid call settles in USDC — click a tx to verify it on-chain.</p>
    <div class="stats rise d2">
      <div class="stat glass"><div class="n" id="stat-runs">–</div><div class="l">Runs shown</div></div>
      <div class="stat glass"><div class="n" id="stat-spend">–</div><div class="l">USDC spent</div></div>
      <div class="stat glass"><div class="n" id="stat-tx">–</div><div class="l">On-chain settlements</div></div>
    </div>
    <div class="sec-head rise d3"><h2>Runs</h2><span class="chip">B · A · D</span></div>
    <div id="runs"><p class="empty glass">Loading…</p></div>
    <div class="sec-head"><h2>Decisions</h2><span class="chip">Mode A</span></div>
    <div id="decisions"><p class="empty glass">Loading…</p></div>
    <p class="foot rise d4">Served by the agent on Railway · data from Upstash · <a href="https://x402jp.com" target="_blank" rel="noopener">x402jp.com</a><span id="updated"></span></p>
  </div>
  <script>${clientJs}</script>
</body>
</html>`;
}
