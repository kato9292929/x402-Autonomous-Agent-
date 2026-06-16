import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { IDENTITY_REGISTRY, AGENT_REGISTRY_ID } from "./erc8004/contract";

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

export function startHttpServer(): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/api/latest-external-data" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200);
      res.end(JSON.stringify(loadExternalData()));
      return;
    }

    if (req.url === "/.well-known/agent-card.json" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200);
      res.end(JSON.stringify(buildAgentCard(), null, 2));
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, () => {
    console.log(`[SERVER] HTTP server listening on port ${port}`);
    console.log(`[SERVER] GET /api/latest-external-data`);
    console.log(`[SERVER] GET /.well-known/agent-card.json (ERC8004_AGENT_ID=${process.env.ERC8004_AGENT_ID ?? "not set"})`);
    console.log(`[SERVER] IdentityRegistry: ${IDENTITY_REGISTRY}`);
  });

  server.on("error", (err) => {
    console.error(`[SERVER] Error: ${err.message}`);
  });
}
