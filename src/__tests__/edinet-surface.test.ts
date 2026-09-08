/**
 * EDINET surface: it is the catalyst engine with a different config, and the two
 * must not share state or spend. This pins the surface values and the separation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aa-edinet-"));
process.chdir(TMP);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

after(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

import { EDINET_SURFACE, CATALYST_SURFACE, OFFICIAL_USDC_MINT } from "../paycall/surface";
import { isExpectedRequirement } from "../catalyst/client";
import { runEdinetSweep } from "../jobs/catalyst-sweep";
import {
  runEdinetAutopilot,
  readAutopilotState,
  writeAutopilotState,
  type AutopilotDeps,
} from "../jobs/catalyst-autopilot";
import type { CatalystRunReport } from "../jobs/catalyst-sweep";
import type { CatalystCallRecord } from "../catalyst/record";
import type { PaymentRequirements } from "@x402/core/types";

test("EDINET surface: /api/edinet・1000 units・公式mint・独立id", () => {
  assert.equal(EDINET_SURFACE.id, "edinet");
  assert.equal(EDINET_SURFACE.listPath, "/api/edinet");
  assert.equal(EDINET_SURFACE.priceUnits, 1000n);
  assert.equal(EDINET_SURFACE.priceUsd, 0.001);
  assert.equal(EDINET_SURFACE.usdcMint, OFFICIAL_USDC_MINT);
  // catalyst と価格/mint は同じでも id は別(state・spend・CSV が混ざらない要)
  assert.notEqual(EDINET_SURFACE.id, CATALYST_SURFACE.id);
});

test("安全弁は EDINET surface でも同じ(Solana/mint/==1000/exact)", () => {
  const req = (over: Record<string, unknown> = {}): PaymentRequirements =>
    ({ scheme: "exact", network: "solana", asset: OFFICIAL_USDC_MINT, amount: "1000", payTo: "SELLER", maxTimeoutSeconds: 60, extra: {}, ...over }) as unknown as PaymentRequirements;
  assert.equal(isExpectedRequirement(req(), EDINET_SURFACE), true);
  assert.equal(isExpectedRequirement(req({ amount: "100" }), EDINET_SURFACE), false); // catalyst旧価格は弾く
  assert.equal(isExpectedRequirement(req({ network: "eip155:8453" }), EDINET_SURFACE), false);
});

test("EDINET autopilot は edinet_autopilot:state を使う(catalyst と別キー)", async () => {
  // catalyst 側を live にしておく。EDINET はそれに影響されず unstarted から始まる。
  await writeAutopilotState({ stage: "live", ticker: "AAPL", smokeTx: "catx" }); // catalyst default
  assert.equal((await readAutopilotState(EDINET_SURFACE)).stage, "unstarted");

  const report = (records: CatalystCallRecord[]): CatalystRunReport => ({
    mode: "sweep", week: "2026-W37", tickers: records.map((r) => r.ticker), records,
    summary: { tickers: records.length, paid: 0, free: 0, skipped: 0, errors: 0, totalUsdc: 0 },
    runSpentUsdc: 0, weekSpentUsdc: 0,
  });
  let onLive = 0;
  const deps: AutopilotDeps = {
    durable: true,
    readState: () => readAutopilotState(EDINET_SURFACE),
    writeState: (s) => writeAutopilotState(s, EDINET_SURFACE),
    runDiscovery: async () =>
      report([{ at: "", ticker: "E7203", outcome: "skipped", latencyMs: 1, payable: true, quotedUnits: ["1000"] }]),
    runSmoke: async (t) =>
      report([{ at: "", ticker: t[0], outcome: "paid", latencyMs: 1, txHash: "edtx", actualUsdc: 0.001, summary: "有報" }]),
    onLive: () => { onLive += 1; },
  };
  const result = await runEdinetAutopilot(deps);
  assert.equal(result.stage, "live");
  assert.equal(result.smokeTx, "edtx");
  assert.equal(onLive, 1);
  // EDINET が live になっても catalyst の live は別キーで健在
  assert.equal((await readAutopilotState()).ticker, "AAPL");
  assert.equal((await readAutopilotState(EDINET_SURFACE)).ticker, "E7203");
});

test("EDINET run0 は /api/edinet を叩き、無課金で 402 を読む", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
  const seen: string[] = [];
  const report = await runEdinetSweep({
    mode: "discovery",
    fetchImpl: (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.endsWith("/api/edinet")) return new Response(JSON.stringify(["E7203", "E6758"]), { status: 200 });
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": b64({
            x402Version: 2, resource: {},
            accepts: [{ scheme: "exact", network: "solana", asset: OFFICIAL_USDC_MINT, amount: "1000", payTo: "S", maxTimeoutSeconds: 60, extra: {} }],
          }),
        },
      });
    }) as typeof globalThis.fetch,
    weekSpentUsdc: 0,
    write: false,
  });
  assert.equal(seen[0], "https://osd.x402jp.com/api/edinet");
  assert.ok(seen[1].startsWith("https://osd.x402jp.com/api/edinet/"));
  assert.equal(report.records[0].payable, true);
  assert.equal(report.runSpentUsdc, 0);
});
