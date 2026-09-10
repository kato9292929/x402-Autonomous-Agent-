/**
 * Pay for a few EDINET codes and print the FULL raw response, so we can see
 * exactly what /api/edinet/{code} returns before pitching "日本株データ on Solana".
 *
 * This is the buyer side (AA): it does not know osd's schema, so it settles the
 * real per-call payments (Solana, ~$0.001 each) through the existing x402 client
 * and dumps the JSON. The output IS the ground-truth schema — more reliable than
 * any doc. The EDINET smoke earlier summarised to `window_days 14 | count 0`, so
 * pay attention to whether `count` is 0 (a 14-day filing window that is empty for
 * companies with no recent filing) vs. an actual financial snapshot.
 *
 *   npm run edinet:inspect            # 2760 7203 6501
 *   npm run edinet:inspect -- 2760 6758 9984
 *
 * Egress required (Railway). Cost = $0.001 × codes.
 */
import "dotenv/config";
import { initX402Fetch, fetchWithPayment } from "../x402";

const BASE = (process.env.OSD_API_BASE ?? "https://osd.x402jp.com").replace(/\/$/, "");
const CATALYST = process.argv.includes("--catalyst");
const ROUTE = CATALYST ? "/api/catalyst" : "/api/edinet";
const argCodes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const CODES = argCodes.length ? argCodes : ["2760", "7203", "6501"];

async function main(): Promise<void> {
  await initX402Fetch();
  console.log(`[EDINET-INSPECT] ${CODES.length} codes via ${BASE}${ROUTE}/{code}\n`);

  for (const code of CODES) {
    const url = `${BASE}${ROUTE}/${encodeURIComponent(code)}`;
    console.log(`\n===== ${code} — ${url} =====`);
    try {
      const res = await fetchWithPayment(url, { method: "GET" });
      const text = await res.text();
      console.log(`HTTP ${res.status}`);
      const tx =
        res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      if (tx) console.log(`(settled — PAYMENT-RESPONSE present)`);
      try {
        const json = JSON.parse(text) as unknown;
        console.log(JSON.stringify(json, null, 2));
        // Flag the empty-window case explicitly.
        const count = (json as { count?: unknown })?.count;
        if (count === 0) console.log(`⚠️  count=0 — この社は返却ウィンドウ内に開示が無い(空窓)`);
      } catch {
        console.log(text.slice(0, 4000));
      }
    } catch (err) {
      console.error(`FAILED ${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n[EDINET-INSPECT] done`);
}

main().catch((err: unknown) => {
  console.error("[EDINET-INSPECT] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
