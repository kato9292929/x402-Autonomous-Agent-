/**
 * MXE 準備スクリプトの純関数。鍵と冪等キーは間違えると取り返しがつかないので固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { base58 } from "@scure/base";
import { generateDeployKey, stableUuid } from "../scripts/mxe-setup";

test("generateDeployKey: Solana CLI 形式(64 バイト = seed ‖ 公開鍵)で、公開鍵が seed と一致する", () => {
  const { json, address } = generateDeployKey();
  const bytes = JSON.parse(json) as number[];
  assert.equal(bytes.length, 64, "arcium deploy --keypair-path が読む 64 バイト配列");
  assert.ok(bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));

  // seed から公開鍵を作り直し、後半 32 バイトと一致することを確かめる。
  // 一致しない鍵ファイルは deploy 時に署名と authority が食い違う。
  const seed = Buffer.from(bytes.slice(0, 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  assert.deepEqual([...pub], bytes.slice(32));
  assert.equal(address, base58.encode(pub), "表示するアドレスは公開鍵の base58");
});

test("generateDeployKey: 呼ぶたびに別の鍵になる", () => {
  assert.notEqual(generateDeployKey().address, generateDeployKey().address);
});

test("stableUuid: 同じ入力から同じ UUID(再実行で二重送金しない)", () => {
  const a = stableUuid("aa-mxe-fund:aa-mxe-buyer-a:v1");
  assert.equal(a, stableUuid("aa-mxe-fund:aa-mxe-buyer-a:v1"));
  assert.notEqual(a, stableUuid("aa-mxe-fund:aa-mxe-buyer-b:v1"), "買い手ごとに別のキー");
  // Circle は UUID 形式を要求する(v4 の version/variant ビットを立てる)。
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("programIdFor matches the deploy job's derive-program-keypair.js", async () => {
  const { generateDeployKey, programIdFor } = await import("../scripts/mxe-setup");
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const key = generateDeployKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mxe-pid-"));
  fs.writeFileSync(path.join(dir, "deploy.json"), key.json);
  const script = path.join(__dirname, "..", "..", "mxe", "scripts", "derive-program-keypair.js");
  const out = execFileSync(process.execPath, [script, path.join(dir, "deploy.json"), path.join(dir, "prog.json")], {
    encoding: "utf-8",
    env: { ...process.env, NODE_PATH: path.join(__dirname, "..", "..", "node_modules") },
  }).trim();
  assert.equal(programIdFor(key.json), out.split("\n").pop());
  assert.notEqual(out, key.address);
});
