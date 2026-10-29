/**
 * Parsing advertised paid routes out of x402 metadata — without inventing any.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdvertisedRoutes } from "../probe/discover-routes";

test("x402 discovery: accepts 配列を持つ resource を有料ルートとして拾う", () => {
  const meta = {
    resources: [
      {
        resource: "/token-details",
        accepts: [
          { scheme: "exact", network: "base", asset: "0xusdc", maxAmountRequired: "1000" },
          { scheme: "exact", network: "solana", asset: "usdc", amount: "2000" },
        ],
      },
      { resource: "/yield-alpha", accepts: [{ network: "base", amount: "5000" }] },
    ],
  };
  const routes = parseAdvertisedRoutes(meta, "/.well-known/x402");
  assert.equal(routes.length, 2);
  const td = routes.find((r) => r.path === "/token-details")!;
  assert.equal(td.priceUsd, 0.001); // 最安(1000 units)
  assert.deepEqual(td.networks, ["base", "solana"]);
  assert.equal(td.from, "/.well-known/x402");
  assert.equal(routes.find((r) => r.path === "/yield-alpha")!.priceUsd, 0.005);
});

test("resource が絶対URLでも path だけ取り出す", () => {
  const routes = parseAdvertisedRoutes(
    { url: "https://x402.ottoai.services/crypto-news", accepts: [{ network: "base", amount: "1000" }] },
    "root"
  );
  assert.equal(routes[0].path, "/crypto-news");
});

test("価格が読めない accepts は price 未設定(0で埋めない)", () => {
  const routes = parseAdvertisedRoutes(
    { resource: "/x", accepts: [{ network: "base" }] },
    "m"
  );
  assert.equal(routes[0].priceUsd, undefined);
});

test("accepts があっても path が無ければルートにしない(捏造しない)", () => {
  assert.deepEqual(parseAdvertisedRoutes({ accepts: [{ amount: "1000" }] }, "m"), []);
});

test("OpenAPI: accepts が無ければ paths からルートを列挙(価格は不明)", () => {
  const routes = parseAdvertisedRoutes(
    { paths: { "/api/networks": { get: {} }, "/api/verify": { post: {} }, "bad": { get: {} } } },
    "/openapi.json"
  );
  assert.equal(routes.length, 2);
  assert.equal(routes.find((r) => r.path === "/api/networks")!.method, "GET");
  assert.equal(routes.find((r) => r.path === "/api/verify")!.method, "POST");
  assert.ok(routes.every((r) => r.priceUsd === undefined), "OpenAPI からは価格を出さない");
});

test("x402 discovery があれば OpenAPI へフォールバックしない", () => {
  const routes = parseAdvertisedRoutes(
    { paths: { "/a": { get: {} } }, item: { resource: "/paid", accepts: [{ amount: "1000" }] } },
    "m"
  );
  assert.deepEqual(routes.map((r) => r.path), ["/paid"]);
});

test("空・非オブジェクトは空配列", () => {
  assert.deepEqual(parseAdvertisedRoutes({}, "m"), []);
  assert.deepEqual(parseAdvertisedRoutes(null, "m"), []);
  assert.deepEqual(parseAdvertisedRoutes("<html>403</html>", "m"), []);
});

test("重複ルートは1つにまとめる", () => {
  const routes = parseAdvertisedRoutes(
    { a: { resource: "/x", accepts: [{ amount: "1000" }] }, b: { resource: "/x", accepts: [{ amount: "1000" }] } },
    "m"
  );
  assert.equal(routes.length, 1);
});
