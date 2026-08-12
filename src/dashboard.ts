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
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Inter:wght@300..600&family=Noto+Sans+JP:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg:#0c0c0c; --panel:#141414; --line:rgba(255,255,255,.09);
    --ink:#ffffff; --muted:#8c8c84; --soft:#cfcfc8;
    --gold:#E8C338; --goldsoft:rgba(232,195,56,.7);
    --ok:#5fd08a; --deg:#E8C338; --err:#f2777a;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:"Inter","Noto Sans JP",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  ::selection { background:rgba(61,129,227,.3); }
  .wrap { max-width:1000px; margin:0 auto; padding:56px 20px 90px; }
  .eyebrow { font-family:"Outfit",sans-serif; font-size:12px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--gold); margin:0 0 14px; }
  h1 { font-family:"Outfit",sans-serif; font-weight:600; font-size:48px; line-height:1.02; letter-spacing:-.02em; margin:0 0 12px; }
  .sub { color:var(--muted); font-size:15px; line-height:1.6; margin:0 0 32px; max-width:680px; }
  .sub b { color:var(--ink); font-weight:500; }
  .stats { display:flex; gap:14px; flex-wrap:wrap; margin:0 0 40px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:18px 22px; min-width:140px; }
  .stat .n { font-family:"Outfit",sans-serif; font-weight:600; font-size:30px; line-height:1; color:var(--gold); }
  .stat .l { color:var(--muted); font-size:11px; margin-top:8px; letter-spacing:.06em; text-transform:uppercase; }
  h2 { font-family:"Outfit",sans-serif; font-weight:600; font-size:22px; letter-spacing:-.01em; margin:40px 0 14px; }
  .empty { color:var(--muted); font-size:14px; background:var(--panel); border:1px dashed var(--line); border-radius:14px; padding:20px; }
  /* decisions */
  .dcard { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:15px 17px; margin-bottom:10px; transition:border-color .15s ease, transform .15s ease; }
  .dcard:hover { border-color:var(--goldsoft); transform:translateY(-1px); }
  .drow { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .dbadge { font-size:12px; font-weight:600; padding:3px 11px; border-radius:999px; }
  .dbadge.buy { background:rgba(95,208,138,.14); color:var(--ok); } .dbadge.skip { background:rgba(255,255,255,.07); color:var(--muted); }
  .ddir { font-size:13px; color:var(--muted); } .dscore { font-size:13px; color:var(--gold); }
  .dwhen { margin-left:auto; font-size:12px; color:var(--muted); }
  .drat { font-size:13.5px; margin-top:9px; color:var(--soft); line-height:1.55; }
  .dmeta { font-size:12px; color:var(--muted); margin-top:7px; }
  /* runs */
  .run { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:6px 6px 8px; margin-bottom:14px; overflow:hidden; transition:border-color .15s ease; }
  .run:hover { border-color:var(--goldsoft); }
  .rhead { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:13px 15px 11px; }
  .mbadge { font-size:11.5px; font-weight:600; padding:3px 10px; border-radius:8px; background:rgba(255,255,255,.06); color:var(--soft); letter-spacing:.02em; }
  .mB{background:rgba(61,129,227,.16);color:#7fb0ff}.mA{background:rgba(180,130,220,.16);color:#c79be6}.mD{background:rgba(95,208,138,.15);color:var(--ok)}.mC{background:rgba(232,195,56,.16);color:var(--gold)}
  .mname { font-size:13px; color:var(--muted); }
  .rwhen { font-size:12px; color:var(--muted); }
  .rtot { margin-left:auto; font-size:12.5px; color:var(--muted); }
  .rtot .ok{color:var(--ok)}.rtot .deg{color:var(--deg)}.rtot .err{color:var(--err)}
  .rspend { font-size:13px; font-variant-numeric:tabular-nums; color:var(--gold); }
  table.rtbl { width:100%; border-collapse:collapse; }
  .rtbl td { padding:8px 11px; font-size:13px; border-top:1px solid var(--line); vertical-align:top; }
  .rtbl .st { width:22px; text-align:center; font-weight:700; }
  .rtbl tr.ok .st{color:var(--ok)}.rtbl tr.deg .st{color:var(--deg)}.rtbl tr.err .st{color:var(--err)}
  .rtbl .pd { font-weight:500; color:#e8e8e2; }
  .rtbl .co { width:64px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .rtbl .tc { width:150px; }
  .rtbl .nt { color:var(--muted); font-size:12px; }
  a.tx { color:var(--gold); text-decoration:none; font-variant-numeric:tabular-nums; }
  a.tx:hover { text-decoration:underline; }
  .notx { color:rgba(255,255,255,.2); }
  .foot { color:var(--muted); font-size:12px; margin-top:30px; padding-top:16px; border-top:1px solid var(--line); }
  #updated { float:right; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">x402 · Autonomous Agent</div>
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
