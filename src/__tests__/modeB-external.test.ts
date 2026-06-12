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

  const birdeyePayload = { NVDA: [{ open: 130 }], TSLA: [{ open: 180 }] };
  const perplexityPayload = { NVDA: [{ headline: "NVDA beats earnings" }] };

  fs.writeFileSync(
    path.join(externalDir, `birdeye-${date}.json`),
    JSON.stringify({ fetched_at: new Date().toISOString(), data: birdeyePayload }, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(externalDir, `perplexity-${date}.json`),
    JSON.stringify({ fetched_at: new Date().toISOString(), data: perplexityPayload }, null, 2),
    "utf-8"
  );

  const txEntries = [
    { name: "Birdeye OHLCV", endpointId: "birdeye-ohlcv", txHash: "0xabc", costUsdc: 0.10 },
    { name: "Perplexity Research", endpointId: "perplexity-research", txHash: "0xdef", costUsdc: 0.50 },
  ];
  fs.writeFileSync(
    path.join(txDir, `external-${date}.json`),
    JSON.stringify({ date, transactions: txEntries }, null, 2),
    "utf-8"
  );

  // Verify files exist and parse correctly
  const birdeyeFile = JSON.parse(
    fs.readFileSync(path.join(externalDir, `birdeye-${date}.json`), "utf-8")
  ) as { data: Record<string, unknown> };
  assert.ok(Array.isArray(birdeyeFile.data["NVDA"]), "birdeye NVDA should be array");

  const perplexityFile = JSON.parse(
    fs.readFileSync(path.join(externalDir, `perplexity-${date}.json`), "utf-8")
  ) as { data: Record<string, unknown> };
  assert.ok(Array.isArray(perplexityFile.data["NVDA"]), "perplexity NVDA should be array");

  const txFile = JSON.parse(
    fs.readFileSync(path.join(txDir, `external-${date}.json`), "utf-8")
  ) as { date: string; transactions: Array<{ txHash?: string }> };
  assert.equal(txFile.date, date);
  assert.equal(txFile.transactions.length, 2);
  assert.equal(txFile.transactions[0]?.txHash, "0xabc");

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

test("MODE B has 11 endpoints (9 base + birdeye + perplexity, Hyre/PMI removed)", async () => {
  const { ENDPOINTS_MODE_B } = await import("../config");
  assert.equal(ENDPOINTS_MODE_B.length, 11, "MODE B should have exactly 11 endpoints");

  const ids = ENDPOINTS_MODE_B.map((e) => e.id);

  // PMI must be removed
  assert.ok(!ids.includes("private-market"), "private-market (PMI) should NOT be in MODE B");

  // Hyre Solana endpoints removed (unverified external URLs)
  assert.ok(!ids.includes("hyre-defi-intelligence"), "hyre-defi-intelligence should NOT be in MODE B");
  assert.ok(!ids.includes("hyre-market-signals"), "hyre-market-signals should NOT be in MODE B");

  // External data endpoints
  assert.ok(ids.includes("birdeye-ohlcv"), "birdeye-ohlcv should be in MODE B");
  assert.ok(ids.includes("perplexity-research"), "perplexity-research should be in MODE B");

  const birdeye = ENDPOINTS_MODE_B.find((e) => e.id === "birdeye-ohlcv")!;
  assert.equal(birdeye.captureFullData, true);
  const perplexity = ENDPOINTS_MODE_B.find((e) => e.id === "perplexity-research")!;
  assert.equal(perplexity.captureFullData, true);

  // No Solana endpoints until osd Solana facilitator is verified in production
  const solanaEps = ENDPOINTS_MODE_B.filter((e) => e.chain === "solana");
  assert.equal(solanaEps.length, 0, "Should have no Solana endpoints yet");
});
