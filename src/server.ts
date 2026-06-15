import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { IDENTITY_REGISTRY, AGENT_REGISTRY_ID } from "./erc8004/contract";

interface ExternalDataResponse {
  fetched_at: string | null;
  birdeye: Record<string, unknown>;
  perplexity: Record<string, unknown>;
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
  const empty: ExternalDataResponse = { fetched_at: null, birdeye: {}, perplexity: {} };

  const birdeyePath = findLatestFile(externalDir, "birdeye-");
  const perplexityPath = findLatestFile(externalDir, "perplexity-");

  if (!birdeyePath && !perplexityPath) return empty;

  let birdeye: Record<string, unknown> = {};
  let perplexity: Record<string, unknown> = {};
  let fetchedAt: string | null = null;

  if (birdeyePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(birdeyePath, "utf-8")) as {
        fetched_at?: string;
        data?: Record<string, unknown>;
      };
      birdeye = parsed.data ?? {};
      fetchedAt = parsed.fetched_at ?? null;
    } catch {
      // unreadable — leave empty
    }
  }

  if (perplexityPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(perplexityPath, "utf-8")) as {
        fetched_at?: string;
        data?: Record<string, unknown>;
      };
      perplexity = parsed.data ?? {};
      if (!fetchedAt) fetchedAt = parsed.fetched_at ?? null;
    } catch {
      // unreadable — leave empty
    }
  }

  return { fetched_at: fetchedAt, birdeye, perplexity };
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
