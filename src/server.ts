import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import QRCode from "qrcode";
import { IDKit, proofOfHuman, type IDKitRequest } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { IDENTITY_REGISTRY, AGENT_REGISTRY_ID } from "./erc8004/contract";
import { findPendingItem, markApproved, listItems } from "./world-id/queue";
import { claimNullifier } from "./world-id/nullifier-store";
import { storeSession, getSession, deleteSession } from "./world-id/idkit-sessions";
import { runModeC } from "./modes/modeC";
import type { WorldIdVerifyResponse } from "./world-id/types";
import type { IDKitResult } from "@worldcoin/idkit-core";
// Re-export IDKitRequest in idkit-sessions.ts uses this type too

interface ExternalDataResponse {
  fetched_at: string | null;
  jin_latest: Record<string, unknown>;
  jin_movers: Record<string, unknown>;
}

function findLatestFile(dir: string, prefix: string): string | null {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort()
      .reverse();
    return files[0] ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

function buildAgentCard(): Record<string, unknown> {
  const baseUrl =
    process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://x402-autonomous-agent-production.up.railway.app";

  const agentIdStr = process.env.ERC8004_AGENT_ID;

  const card: Record<string, unknown> = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "x402 Autonomous Agent",
    description:
      "Autonomous agent that consumes paid data endpoints daily via the x402 payment protocol on Base (EVM) and Solana.",
    services: [
      { name: "web", endpoint: baseUrl },
    ],
    x402Support: true,
    active: true,
    supportedTrust: ["crypto-economic"],
  };

  if (agentIdStr) {
    card.registrations = [
      {
        agentRegistry: AGENT_REGISTRY_ID,
        agentId: agentIdStr,
      },
    ];
  }

  return card;
}

function loadExternalData(): ExternalDataResponse {
  const externalDir = path.join(process.cwd(), "data", "external");
  const empty: ExternalDataResponse = { fetched_at: null, jin_latest: {}, jin_movers: {} };

  const jinLatestPath = findLatestFile(externalDir, "jin-latest-");
  const jinMoversPath = findLatestFile(externalDir, "jin-movers-");

  if (!jinLatestPath && !jinMoversPath) return empty;

  let jin_latest: Record<string, unknown> = {};
  let jin_movers: Record<string, unknown> = {};
  let fetchedAt: string | null = null;

  if (jinLatestPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jinLatestPath, "utf-8")) as {
        fetched_at?: string;
        data?: Record<string, unknown>;
      };
      jin_latest = parsed.data ?? {};
      fetchedAt = parsed.fetched_at ?? null;
    } catch {
      // unreadable — leave empty
    }
  }

  if (jinMoversPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jinMoversPath, "utf-8")) as {
        fetched_at?: string;
        data?: Record<string, unknown>;
      };
      jin_movers = parsed.data ?? {};
      if (!fetchedAt) fetchedAt = parsed.fetched_at ?? null;
    } catch {
      // unreadable — leave empty
    }
  }

  return { fetched_at: fetchedAt, jin_latest, jin_movers };
}

function getRequiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(body);
}

function getActionForQueue(queueId: string): string {
  return `approve-mode-c-${queueId}`;
}

function isValidQueueAction(action: string): boolean {
  return /^approve-mode-c-[0-9]{8}-[0-9a-f]{8}$/.test(action);
}

function buildApprovePage(queueId: string, qrDataUrl: string, connectorURI: string, requestId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>x402 Agent — Approve Mode C</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; }
    h1 { font-size: 1.25rem; }
    .card { background: #f5f5f5; border-radius: 8px; padding: 16px; margin: 16px 0; }
    img { display: block; margin: 16px auto; width: 240px; height: 240px; }
    a.link { word-break: break-all; font-size: 0.85rem; color: #0070f3; }
    #status { margin-top: 16px; font-weight: bold; }
    .ok { color: green; } .err { color: red; }
  </style>
</head>
<body>
  <h1>x402 Agent — Approve Mode C Run</h1>
  <div class="card">
    <p><strong>Queue ID:</strong> ${queueId}</p>
    <p>Scan with World App to authorize the weekly Mode C data run.</p>
    <img src="${qrDataUrl}" alt="World ID QR code">
    <p>On mobile: <a class="link" href="${connectorURI}">tap here to open World App</a></p>
  </div>
  <div id="status">Waiting for World App scan…</div>
  <script>
    const requestId = ${JSON.stringify(requestId)};
    const queueId = ${JSON.stringify(queueId)};
    const statusEl = document.getElementById('status');

    async function poll() {
      try {
        const res = await fetch('/api/world-id/poll?requestId=' + encodeURIComponent(requestId) + '&queueId=' + encodeURIComponent(queueId));
        const data = await res.json();
        if (data.type === 'confirmed') {
          statusEl.textContent = '✓ Verified! Executing Mode C…';
          statusEl.className = 'ok';
          const execRes = await fetch('/api/world-id/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proof: data.result, queueId })
          });
          const execData = await execRes.json();
          if (execRes.ok) {
            statusEl.textContent = '✓ Mode C execution started. Check Railway logs.';
          } else {
            statusEl.textContent = '✗ Error: ' + (execData.error || 'unknown');
            statusEl.className = 'err';
          }
          return;
        }
        if (data.type === 'failed') {
          statusEl.textContent = '✗ Verification failed: ' + data.error;
          statusEl.className = 'err';
          return;
        }
        setTimeout(poll, 2000);
      } catch (e) {
        setTimeout(poll, 3000);
      }
    }

    setTimeout(poll, 2000);
  </script>
</body>
</html>`;
}

async function handleApproveGet(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queueId = url.searchParams.get("id");

  if (!queueId) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing ?id= parameter");
    return;
  }

  const item = await findPendingItem(queueId);
  if (!item) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Queue item not found or already approved");
    return;
  }

  const appId = getRequiredEnv("WLD_APP_ID") as `app_${string}`;
  const rpId = getRequiredEnv("WLD_RP_ID");
  const signingKeyHex = getRequiredEnv("WLD_SIGNING_KEY");
  const action = getActionForQueue(queueId);

  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex, action });
  const rpContext = { rp_id: rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig };

  const idkitReq = await IDKit.request({
    app_id: appId,
    action,
    rp_context: rpContext,
    allow_legacy_proofs: false,
  }).preset(proofOfHuman());

  storeSession(idkitReq.requestId, idkitReq);

  const qrDataUrl = await QRCode.toDataURL(idkitReq.connectorURI);

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildApprovePage(queueId, qrDataUrl, idkitReq.connectorURI, idkitReq.requestId));
}

async function handlePoll(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestId = url.searchParams.get("requestId");

  if (!requestId) {
    sendJson(res, 400, { error: "Missing requestId" });
    return;
  }

  const session = getSession(requestId);
  if (!session) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }

  const status = await session.pollOnce();

  if (status.type === "confirmed") {
    deleteSession(requestId);
    sendJson(res, 200, { type: "confirmed", result: status.result });
    return;
  }
  if (status.type === "failed") {
    deleteSession(requestId);
    sendJson(res, 200, { type: "failed", error: status.error });
    return;
  }
  sendJson(res, 200, { type: status.type });
}

async function handleVerify(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: { proof?: IDKitResult; queueId?: string };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { proof, queueId } = body;
  if (!proof || !queueId) {
    sendJson(res, 400, { error: "Missing proof or queueId" });
    return;
  }

  const item = await findPendingItem(queueId);
  if (!item) {
    sendJson(res, 409, { error: "Queue item not found or already approved" });
    return;
  }

  const expectedAction = getActionForQueue(queueId);

  // For uniqueness proofs (v4), action is on the result
  const resultAction = "action" in proof ? (proof as IDKitResultV4Shape).action : undefined;
  if (resultAction !== undefined && resultAction !== expectedAction) {
    sendJson(res, 400, { error: "Action mismatch" });
    return;
  }

  const rpId = getRequiredEnv("WLD_RP_ID");
  const verifyUrl = `https://developer.world.org/api/v4/verify/${encodeURIComponent(rpId)}`;

  let worldRes: Response;
  try {
    worldRes = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    });
  } catch (err) {
    sendJson(res, 502, { error: `World ID verify request failed: ${String(err)}` });
    return;
  }

  if (!worldRes.ok) {
    const text = await worldRes.text().catch(() => "(no body)");
    sendJson(res, 400, { error: `World ID verification failed: HTTP ${worldRes.status} — ${text.slice(0, 300)}` });
    return;
  }

  const worldData = (await worldRes.json()) as WorldIdVerifyResponse;
  const nullifier = worldData.nullifier ?? worldData.results?.[0]?.nullifier;

  if (!nullifier) {
    sendJson(res, 502, { error: "World ID response missing nullifier" });
    return;
  }

  // Atomic claim (SET NX): rejects a replayed / double (nullifier, action).
  const claimed = await claimNullifier(nullifier, expectedAction);
  if (!claimed) {
    sendJson(res, 409, { error: "Nullifier already used for this action" });
    return;
  }

  await markApproved(queueId);

  console.log(`[WORLD-ID] Verified — queueId=${queueId}, nullifier=${nullifier.slice(0, 16)}…`);

  // Fire Mode C in background (don't await — returns 200 immediately)
  runModeC().catch((err: unknown) => {
    console.error("[WORLD-ID] Mode C execution error:", err);
  });

  sendJson(res, 200, { ok: true, message: "Mode C execution started" });
}

// Minimal shape for checking action field on IDKitResultV4
interface IDKitResultV4Shape { action: string }

async function handleRpSig(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: { action?: string };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { action } = body;
  if (!action || !isValidQueueAction(action)) {
    sendJson(res, 400, { error: "Invalid or missing action" });
    return;
  }

  const signingKeyHex = getRequiredEnv("WLD_SIGNING_KEY");
  const rpId = getRequiredEnv("WLD_RP_ID");

  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex, action });
  sendJson(res, 200, {
    rp_id: rpId,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
    signature: sig,
  });
}

export function startHttpServer(): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const server = http.createServer((req, res) => {
    const urlPath = req.url?.split("?")[0] ?? "/";

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }

    // Static routes
    if (urlPath === "/api/latest-external-data" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200);
      res.end(JSON.stringify(loadExternalData()));
      return;
    }

    if (urlPath === "/.well-known/agent-card.json" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200);
      res.end(JSON.stringify(buildAgentCard(), null, 2));
      return;
    }

    if (urlPath === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
      return;
    }

    // World ID routes
    if (urlPath === "/approve" && req.method === "GET") {
      handleApproveGet(req, res).catch((err: unknown) => {
        console.error("[SERVER] /approve error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Internal error: ${String(err)}`);
        }
      });
      return;
    }

    if (urlPath === "/api/world-id/poll" && req.method === "GET") {
      handlePoll(req, res).catch((err: unknown) => {
        console.error("[SERVER] /api/world-id/poll error:", err);
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    if (urlPath === "/api/world-id/verify" && req.method === "POST") {
      handleVerify(req, res).catch((err: unknown) => {
        console.error("[SERVER] /api/world-id/verify error:", err);
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    if (urlPath === "/api/world-id/rp-sig" && req.method === "POST") {
      handleRpSig(req, res).catch((err: unknown) => {
        console.error("[SERVER] /api/world-id/rp-sig error:", err);
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    if (urlPath === "/api/world-id/queue" && req.method === "GET") {
      listItems()
        .then((items) => sendJson(res, 200, { items }))
        .catch((err: unknown) => {
          console.error("[SERVER] /api/world-id/queue error:", err);
          if (!res.headersSent) sendJson(res, 500, { error: String(err) });
        });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, () => {
    console.log(`[SERVER] HTTP server listening on port ${port}`);
    console.log(`[SERVER] GET  /api/latest-external-data`);
    console.log(`[SERVER] GET  /.well-known/agent-card.json`);
    console.log(`[SERVER] GET  /approve?id={queueId}        — World ID approval page`);
    console.log(`[SERVER] POST /api/world-id/rp-sig         — RP signature`);
    console.log(`[SERVER] GET  /api/world-id/poll           — Poll IDKit request`);
    console.log(`[SERVER] POST /api/world-id/verify         — Verify proof + execute Mode C`);
    console.log(`[SERVER] GET  /api/world-id/queue          — List pending approvals`);
    console.log(`[SERVER] IdentityRegistry: ${IDENTITY_REGISTRY}`);
  });

  server.on("error", (err) => {
    console.error(`[SERVER] Error: ${err.message}`);
  });
}
