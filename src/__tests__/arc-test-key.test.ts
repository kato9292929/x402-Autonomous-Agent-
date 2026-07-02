/**
 * Arc スクリプトが Circle TEST キー(CIRCLE_API_KEY_TEST / CIRCLE_ENTITY_SECRET_TEST)を
 * 読み、未設定時に LIVE(CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET)へフォールバックせず停止する
 * ことを検証する(156006 の再発防止)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getRequiredArcTestApiKey,
  buildArcTestEntitySecretCiphertext,
} from "../circle/arc-test-client";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(vars);
  const orig: Record<string, string | undefined> = {};
  for (const k of keys) {
    orig[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}

test("getRequiredArcTestApiKey は CIRCLE_API_KEY_TEST を読む", () => {
  withEnv({ CIRCLE_API_KEY_TEST: "TEST_API_KEY:abc" }, () => {
    assert.equal(getRequiredArcTestApiKey(), "TEST_API_KEY:abc");
  });
});

test("TEST キー未設定なら LIVE があっても停止(フォールバックしない)", () => {
  // LIVE だけセットして TEST 未設定 → throw(LIVE を返さない)
  withEnv({ CIRCLE_API_KEY_TEST: undefined, CIRCLE_API_KEY: "LIVE_API_KEY:should-not-be-used" }, () => {
    assert.throws(() => getRequiredArcTestApiKey(), /CIRCLE_API_KEY_TEST is required/);
  });
});

test("entity secret も TEST 未設定なら停止(LIVE へフォールバックしない・ネットワーク前に停止)", async () => {
  await withEnvAsync(
    { CIRCLE_ENTITY_SECRET_TEST: undefined, CIRCLE_ENTITY_SECRET: "LIVE_SECRET" },
    async () => {
      await assert.rejects(
        () => buildArcTestEntitySecretCiphertext("TEST_API_KEY:abc"),
        /CIRCLE_ENTITY_SECRET_TEST is required/
      );
    }
  );
});

async function withEnvAsync(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const keys = Object.keys(vars);
  const orig: Record<string, string | undefined> = {};
  for (const k of keys) {
    orig[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of keys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}
