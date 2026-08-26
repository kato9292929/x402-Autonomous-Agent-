/**
 * Which Solana signer the agent picks, given the env.
 *
 * The switch must be reversible from env alone: turning Circle on requires an
 * explicit opt-in, and an incomplete Circle config must not silently fall back
 * to the local key (that would pay from a different wallet than intended).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSolanaBackend } from "../circle/solana-signer";

const KEYS = [
  "SOLANA_SIGNER_BACKEND",
  "SOLANA_PRIVATE_KEY",
  "CIRCLE_API_KEY",
  "CIRCLE_ENTITY_SECRET",
  "CIRCLE_SOLANA_WALLET_ID",
  "CIRCLE_SOLANA_WALLET_ADDRESS",
];

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

const CIRCLE_ENV = {
  CIRCLE_API_KEY: "k",
  CIRCLE_ENTITY_SECRET: "s",
  CIRCLE_SOLANA_WALLET_ID: "fe528e05",
  CIRCLE_SOLANA_WALLET_ADDRESS: "7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY",
};

test("既定はローカル鍵(Circle への切替は明示的な opt-in)", () => {
  withEnv({ SOLANA_PRIVATE_KEY: "abc", ...CIRCLE_ENV }, () => {
    assert.equal(resolveSolanaBackend(), "privatekey");
  });
});

test("SOLANA_SIGNER_BACKEND=circle かつ CIRCLE_SOLANA_* 一式が揃えば circle", () => {
  withEnv({ SOLANA_SIGNER_BACKEND: "circle", ...CIRCLE_ENV }, () => {
    assert.equal(resolveSolanaBackend(), "circle");
  });
});

test("circle 指定なのに設定が欠けていたら、黙ってローカル鍵に落ちない", () => {
  withEnv(
    { SOLANA_SIGNER_BACKEND: "circle", SOLANA_PRIVATE_KEY: "abc", CIRCLE_API_KEY: "k" },
    () => {
      // 意図と違うウォレットから払うくらいなら、払わない
      assert.equal(resolveSolanaBackend(), "none");
    }
  );
});

test("何も設定が無ければ none(Solana はスキップ)", () => {
  withEnv({}, () => {
    assert.equal(resolveSolanaBackend(), "none");
  });
});

test("circle → privatekey へは env だけで戻せる", () => {
  withEnv({ SOLANA_SIGNER_BACKEND: "privatekey", SOLANA_PRIVATE_KEY: "abc", ...CIRCLE_ENV }, () => {
    assert.equal(resolveSolanaBackend(), "privatekey");
  });
});
