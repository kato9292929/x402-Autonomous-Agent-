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
  if (!decisions.length) return '<p class="empty">No Mode A decisions recorded yet.</p>';
  return decisions.map((d) => {
    const c = d.call || {};
    const act = c.action || "—";
    const badge = act === "BUY" ? "buy" : "skip";
    return '<div class="dcard">'
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
  return '<section class="run">'
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
    $("#runs").innerHTML = runs.length ? runs.map(renderRun).join("") : '<p class="empty">No runs recorded yet. They appear after the next daily run (06:00 JST).</p>';
    $("#updated").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("#runs").innerHTML = '<p class="empty">Could not load records: ' + esc(String(e)) + '</p>';
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
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300..600&display=swap" rel="stylesheet" />
<style>
  :root { --bg:#F3F4ED; --ink:#1a1a1a; --muted:#6b6f63; --line:rgba(26,26,26,.10); --card:#fbfcf7; --blue:#0871E7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:"Inter",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1000px; margin:0 auto; padding:56px 20px 80px; }
  h1 { font-family:"Instrument Serif",serif; font-weight:400; font-size:52px; line-height:.95; letter-spacing:-.01em; margin:0 0 8px; }
  .sub { color:var(--muted); font-size:15px; margin:0 0 28px; }
  .sub b { color:var(--ink); font-weight:500; }
  .stats { display:flex; gap:14px; flex-wrap:wrap; margin:0 0 34px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px 20px; min-width:130px; }
  .stat .n { font-family:"Instrument Serif",serif; font-size:30px; line-height:1; }
  .stat .l { color:var(--muted); font-size:12px; margin-top:6px; letter-spacing:.02em; }
  h2 { font-family:"Instrument Serif",serif; font-weight:400; font-size:26px; margin:34px 0 14px; }
  .empty { color:var(--muted); font-size:14px; background:var(--card); border:1px dashed var(--line); border-radius:14px; padding:20px; }
  /* decisions */
  .dcard { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; margin-bottom:10px; }
  .drow { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .dbadge { font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; }
  .dbadge.buy { background:#e7f3ea; color:#1f7a3f; } .dbadge.skip { background:#efece4; color:#8a8575; }
  .ddir { font-size:13px; color:var(--muted); } .dscore { font-size:13px; color:var(--muted); }
  .dwhen { margin-left:auto; font-size:12px; color:var(--muted); }
  .drat { font-size:13.5px; margin-top:8px; color:var(--ink); line-height:1.5; }
  .dmeta { font-size:12px; color:var(--muted); margin-top:6px; }
  /* runs */
  .run { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:6px 6px 8px; margin-bottom:14px; overflow:hidden; }
  .rhead { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 14px 10px; }
  .mbadge { font-size:12px; font-weight:600; padding:3px 9px; border-radius:8px; background:#eceadf; color:#4a4d42; }
  .mB{background:#e6eef7;color:#215a9e}.mA{background:#efe7f3;color:#6a3f8a}.mD{background:#e7f3ea;color:#1f7a3f}.mC{background:#f3ece0;color:#9a6a1e}
  .mname { font-size:13px; color:var(--muted); }
  .rwhen { font-size:12px; color:var(--muted); }
  .rtot { margin-left:auto; font-size:12.5px; color:var(--muted); }
  .rtot .ok{color:#1f7a3f}.rtot .deg{color:#9a6a1e}.rtot .err{color:#b23b3b}
  .rspend { font-size:13px; font-variant-numeric:tabular-nums; }
  table.rtbl { width:100%; border-collapse:collapse; }
  .rtbl td { padding:7px 10px; font-size:13px; border-top:1px solid var(--line); vertical-align:top; }
  .rtbl .st { width:22px; text-align:center; font-weight:700; }
  .rtbl tr.ok .st{color:#1f7a3f}.rtbl tr.deg .st{color:#9a6a1e}.rtbl tr.err .st{color:#b23b3b}
  .rtbl .pd { font-weight:500; }
  .rtbl .co { width:64px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .rtbl .tc { width:150px; }
  .rtbl .nt { color:var(--muted); font-size:12px; }
  a.tx { color:var(--blue); text-decoration:none; font-variant-numeric:tabular-nums; }
  a.tx:hover { text-decoration:underline; }
  .notx { color:var(--line); }
  .foot { color:var(--muted); font-size:12px; margin-top:26px; }
  #updated { float:right; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Daily records</h1>
    <p class="sub">On-chain record of what the <b>x402 autonomous agent</b> (ERC-8004 agentId <b>${agentId}</b>) paid for and decided, each day. Every paid call settles in USDC — click a tx to verify it on-chain.</p>
    <div class="stats">
      <div class="stat"><div class="n" id="stat-runs">–</div><div class="l">RUNS SHOWN</div></div>
      <div class="stat"><div class="n" id="stat-spend">–</div><div class="l">USDC SPENT</div></div>
      <div class="stat"><div class="n" id="stat-tx">–</div><div class="l">ON-CHAIN SETTLEMENTS</div></div>
    </div>
    <h2>Decisions</h2>
    <div id="decisions"><p class="empty">Loading…</p></div>
    <h2>Runs</h2>
    <div id="runs"><p class="empty">Loading…</p></div>
    <p class="foot">Served by the agent on Railway · data from Upstash · <span id="updated"></span></p>
  </div>
  <script>${clientJs}</script>
</body>
</html>`;
}
