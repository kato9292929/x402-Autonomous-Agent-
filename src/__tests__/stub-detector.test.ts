/**
 * Tests for detectDegraded stub/fallback detection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDegraded } from "../stub-detector";

test("clean response is not degraded", () => {
  const result = detectDegraded({ price: 42.5, timestamp: "2026-06-16T00:00:00Z" });
  assert.equal(result.degraded, false);
});

test("source=sample-data is degraded", () => {
  const result = detectDegraded({ source: "sample-data", price: 1.0 });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("sample-data"));
});

test("dataMode=fallback is degraded", () => {
  const result = detectDegraded({ dataMode: "fallback", items: [] });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("fallback"));
});

test("mock=true is degraded", () => {
  const result = detectDegraded({ mock: true, value: 99 });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("mock=true"));
});

test("isMock=true is degraded", () => {
  const result = detectDegraded({ isMock: true, value: 99 });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("isMock=true"));
});

test("status=stub is degraded", () => {
  const result = detectDegraded({ status: "stub", data: {} });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("status=stub"));
});

test("status=ok is not degraded", () => {
  const result = detectDegraded({ status: "ok", price: 5.0 });
  assert.equal(result.degraded, false);
});

test("fake short eth tx_hash is degraded", () => {
  const result = detectDegraded({ tx_hash: "0xdeadbeef" });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("tx_hash"));
});

test("full-length eth tx_hash is not degraded", () => {
  const realHash = "0x" + "a".repeat(64);
  const result = detectDegraded({ tx_hash: realHash });
  assert.equal(result.degraded, false);
});

test("nested data object with stub marker is degraded", () => {
  const result = detectDegraded({ data: { source: "sample-data", price: 1.0 } });
  assert.equal(result.degraded, true);
  if (result.degraded) assert.ok(result.reason.includes("sample-data"));
});

test("nested data array is not inspected (not degraded by default)", () => {
  const result = detectDegraded({ data: [{ mock: true }] });
  assert.equal(result.degraded, false);
});

test("degraded markers with non-matching values are clean", () => {
  assert.equal(detectDegraded({ mock: false }).degraded, false);
  assert.equal(detectDegraded({ isMock: false }).degraded, false);
  assert.equal(detectDegraded({ source: "live" }).degraded, false);
  assert.equal(detectDegraded({ dataMode: "live" }).degraded, false);
});
