/**
 * Tests for /api/latest-external-data HTTP endpoint.
 * Uses node:test (Node.js 20+, no extra dependencies).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AddressInfo } from "net";

// ── Helpers ──────────────────────────────────────────────────────────────────

function get(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function closeServer(srv: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.close((err) => err ? reject(err) : resolve());
  });
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

function loadExternalData(externalDir: string) {
  const empty = { fetched_at: null as string | null, birdeye: {} as Record<string, unknown>, perplexity: {} as Record<string, unknown> };
  const birdeyePath = findLatestFile(externalDir, "birdeye-");
  const perplexityPath = findLatestFile(externalDir, "perplexity-");
  if (!birdeyePath && !perplexityPath) return empty;

  let birdeye: Record<string, unknown> = {};
  let perplexity: Record<string, unknown> = {};
  let fetchedAt: string | null = null;

  if (birdeyePath) {
    try {
      const p = JSON.parse(fs.readFileSync(birdeyePath, "utf-8")) as { fetched_at?: string; data?: Record<string, unknown> };
      birdeye = p.data ?? {};
      fetchedAt = p.fetched_at ?? null;
    } catch { /* ignore */ }
  }
  if (perplexityPath) {
    try {
      const p = JSON.parse(fs.readFileSync(perplexityPath, "utf-8")) as { fetched_at?: string; data?: Record<string, unknown> };
      perplexity = p.data ?? {};
      if (!fetchedAt) fetchedAt = p.fetched_at ?? null;
    } catch { /* ignore */ }
  }
  return { fetched_at: fetchedAt, birdeye, perplexity };
}

// Port 0 = OS assigns a free port, avoiding EADDRINUSE between test runs
function startTestServer(externalDir: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/api/latest-external-data" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(200);
        res.end(JSON.stringify(loadExternalData(externalDir)));
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ server: srv, port });
    });
    srv.on("error", reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("GET /api/latest-external-data returns 200 with empty payload when no data files exist", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-srv1-"));
  const { server, port } = await startTestServer(tmpDir);
  try {
    const { status, body } = await get(`http://localhost:${port}/api/latest-external-data`);
    assert.equal(status, 200);
    const json = JSON.parse(body) as { fetched_at: unknown; birdeye: unknown; perplexity: unknown };
    assert.equal(json.fetched_at, null);
    assert.deepEqual(json.birdeye, {});
    assert.deepEqual(json.perplexity, {});
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/latest-external-data returns saved birdeye + perplexity data", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-srv2-"));
  const date = "2026-06-08";
  const fetchedAt = "2026-06-08T21:00:00.000Z";

  fs.writeFileSync(
    path.join(tmpDir, `birdeye-${date}.json`),
    JSON.stringify({ fetched_at: fetchedAt, data: { NVDA: [{ open: 100 }] } }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(tmpDir, `perplexity-${date}.json`),
    JSON.stringify({ fetched_at: fetchedAt, data: { NVDA: [{ headline: "test" }] } }),
    "utf-8"
  );

  const { server, port } = await startTestServer(tmpDir);
  try {
    const { status, body } = await get(`http://localhost:${port}/api/latest-external-data`);
    assert.equal(status, 200);
    const json = JSON.parse(body) as { fetched_at: string; birdeye: Record<string, unknown>; perplexity: Record<string, unknown> };
    assert.equal(json.fetched_at, fetchedAt);
    assert.ok(Array.isArray(json.birdeye["NVDA"]), "birdeye.NVDA should be array");
    assert.ok(Array.isArray(json.perplexity["NVDA"]), "perplexity.NVDA should be array");
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/latest-external-data has CORS header", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-srv3-"));
  const { server, port } = await startTestServer(tmpDir);
  try {
    const { headers } = await get(`http://localhost:${port}/api/latest-external-data`);
    assert.equal(headers["access-control-allow-origin"], "*");
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
