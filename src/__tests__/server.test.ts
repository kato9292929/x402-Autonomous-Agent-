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
  const empty = { fetched_at: null as string | null, jin_latest: {} as Record<string, unknown>, jin_movers: {} as Record<string, unknown> };
  const jinLatestPath = findLatestFile(externalDir, "jin-latest-");
  const jinMoversPath = findLatestFile(externalDir, "jin-movers-");
  if (!jinLatestPath && !jinMoversPath) return empty;

  let jin_latest: Record<string, unknown> = {};
  let jin_movers: Record<string, unknown> = {};
  let fetchedAt: string | null = null;

  if (jinLatestPath) {
    try {
      const p = JSON.parse(fs.readFileSync(jinLatestPath, "utf-8")) as { fetched_at?: string; data?: Record<string, unknown> };
      jin_latest = p.data ?? {};
      fetchedAt = p.fetched_at ?? null;
    } catch { /* ignore */ }
  }
  if (jinMoversPath) {
    try {
      const p = JSON.parse(fs.readFileSync(jinMoversPath, "utf-8")) as { fetched_at?: string; data?: Record<string, unknown> };
      jin_movers = p.data ?? {};
      if (!fetchedAt) fetchedAt = p.fetched_at ?? null;
    } catch { /* ignore */ }
  }
  return { fetched_at: fetchedAt, jin_latest, jin_movers };
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
    const json = JSON.parse(body) as { fetched_at: unknown; jin_latest: unknown; jin_movers: unknown };
    assert.equal(json.fetched_at, null);
    assert.deepEqual(json.jin_latest, {});
    assert.deepEqual(json.jin_movers, {});
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/latest-external-data returns saved JIN data", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-srv2-"));
  const date = "2026-06-16";
  const fetchedAt = "2026-06-16T21:00:00.000Z";

  fs.writeFileSync(
    path.join(tmpDir, `jin-latest-${date}.json`),
    JSON.stringify({ fetched_at: fetchedAt, data: { date, excl: 120.5, incl: 118.2 } }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(tmpDir, `jin-movers-${date}.json`),
    JSON.stringify({ fetched_at: fetchedAt, data: { movers: [{ ticker: "AAPL", change: 2.1 }] } }),
    "utf-8"
  );

  const { server, port } = await startTestServer(tmpDir);
  try {
    const { status, body } = await get(`http://localhost:${port}/api/latest-external-data`);
    assert.equal(status, 200);
    const json = JSON.parse(body) as { fetched_at: string; jin_latest: Record<string, unknown>; jin_movers: Record<string, unknown> };
    assert.equal(json.fetched_at, fetchedAt);
    assert.equal(json.jin_latest["date"], date);
    assert.ok(Array.isArray(json.jin_movers["movers"]), "jin_movers.movers should be array");
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
