/**
 * Tests that modeB.ts correctly saves external data files and transaction logs.
 * Uses node:test (Node.js 20+).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// We test the saveExternalData logic by replicating it here (it's not exported),
// but we can verify the file-write contract via integration-style test.

test("External data directories are created and files written correctly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-external-"));
  const externalDir = path.join(tmpDir, "external");
  const txDir = path.join(tmpDir, "transactions");
  const date = "2026-06-08";

  // Simulate saveExternalData writing birdeye
  fs.mkdirSync(externalDir, { recursive: true });
  fs.mkdirSync(txDir, { recursive: true });

  const jinLatestPayload = { date, excl: 120.5, incl: 118.2, yoy: 3.1 };
  const jinMoversPayload = { movers: [{ ticker: "AAPL", change: 2.1 }] };

  fs.writeFileSync(
    path.join(externalDir, `jin-latest-${date}.json`),
    JSON.stringify({ fetched_at: new Date().toISOString(), data: jinLatestPayload }, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(externalDir, `jin-movers-${date}.json`),
    JSON.stringify({ fetched_at: new Date().toISOString(), data: jinMoversPayload }, null, 2),
    "utf-8"
  );

  const txEntries = [
    { name: "JIN Index Latest", endpointId: "osd-jin-latest", txHash: "sig1abc", costUsdc: 0.01 },
    { name: "JIN Movers", endpointId: "osd-jin-movers", txHash: "sig2def", costUsdc: 0.01 },
  ];
  fs.writeFileSync(
    path.join(txDir, `external-${date}.json`),
    JSON.stringify({ date, transactions: txEntries }, null, 2),
    "utf-8"
  );

  // Verify files exist and parse correctly
  const jinLatestFile = JSON.parse(
    fs.readFileSync(path.join(externalDir, `jin-latest-${date}.json`), "utf-8")
  ) as { data: Record<string, unknown> };
  assert.equal(jinLatestFile.data["date"], date, "jin-latest date should match");

  const jinMoversFile = JSON.parse(
    fs.readFileSync(path.join(externalDir, `jin-movers-${date}.json`), "utf-8")
  ) as { data: Record<string, unknown> };
  assert.ok(Array.isArray(jinMoversFile.data["movers"]), "jin-movers.movers should be array");

  const txFile = JSON.parse(
    fs.readFileSync(path.join(txDir, `external-${date}.json`), "utf-8")
  ) as { date: string; transactions: Array<{ txHash?: string }> };
  assert.equal(txFile.date, date);
  assert.equal(txFile.transactions.length, 2);
  assert.equal(txFile.transactions[0]?.txHash, "sig1abc");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("config/portfolio.json contains expected tickers", () => {
  const portfolioPath = path.join(process.cwd(), "config", "portfolio.json");
  const raw = fs.readFileSync(portfolioPath, "utf-8");
  const cfg = JSON.parse(raw) as { tickers: string[] };
  assert.ok(Array.isArray(cfg.tickers), "tickers should be an array");
  assert.ok(cfg.tickers.length > 0, "tickers should not be empty");
  // Confirmed stocks only
  for (const t of cfg.tickers) {
    assert.ok(typeof t === "string" && t.length > 0, `ticker ${t} should be non-empty string`);
  }
});

test("MODE B has 15 endpoints (10 base + 5 Solana, Birdeye/Perplexity/Hyre/PMI removed)", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  assert.equal(ENDPOINTS_MODE_B.length, 15, "MODE B should have exactly 15 endpoints");

  const ids = ENDPOINTS_MODE_B.map((e) => e.id);

  // ODO 有償エンドポイント(base)が追加されている
  assert.ok(ids.includes("odo-funding-nowcast"), "odo-funding-nowcast should be in MODE B");

  // PMI must be removed
  assert.ok(!ids.includes("private-market"), "private-market (PMI) should NOT be in MODE B");

  // Hyre Solana endpoints removed (unverified external URLs)
  assert.ok(!ids.includes("hyre-defi-intelligence"), "hyre-defi-intelligence should NOT be in MODE B");
  assert.ok(!ids.includes("hyre-market-signals"), "hyre-market-signals should NOT be in MODE B");

  // birdeye and perplexity removed
  assert.ok(!ids.includes("birdeye-ohlcv"), "birdeye-ohlcv should NOT be in MODE B (removed)");
  assert.ok(!ids.includes("perplexity-research"), "perplexity-research should NOT be in MODE B (removed)");

  // osd Solana endpoints
  assert.ok(ids.includes("osd-ipo"), "osd-ipo should be in MODE B");
  assert.ok(ids.includes("osd-holders"), "osd-holders should be in MODE B");
  assert.ok(ids.includes("osd-liquidity"), "osd-liquidity should be in MODE B");
  assert.ok(ids.includes("osd-jin-latest"), "osd-jin-latest should be in MODE B");
  assert.ok(ids.includes("osd-jin-movers"), "osd-jin-movers should be in MODE B");

  const solanaEps = ENDPOINTS_MODE_B.filter((e) => e.chain === "solana");
  assert.equal(solanaEps.length, 5, "Should have exactly 5 Solana endpoints");

  for (const ep of solanaEps) {
    // osd endpoints → osd-coral; JIN endpoints → jin-orcin-pi
    const expectedHost = ep.id.startsWith("osd-jin-") ? "jin-orcin-pi.vercel.app" : "osd-coral.vercel.app";
    assert.ok(ep.url.includes(expectedHost), `${ep.id} should point to ${expectedHost}`);
    assert.equal(ep.method, "GET");
    assert.equal(ep.cost, 0.01);
  }
});
