/**
 * One-time setup: register your Circle Entity Secret.
 *
 * Steps:
 *   1. If you don't have an entity secret yet, generate one (32-byte hex):
 *        npx ts-node -e "require('@circle-fin/developer-controlled-wallets').generateEntitySecret()"
 *      Put the printed value in .env as CIRCLE_ENTITY_SECRET (never commit it).
 *   2. Run this script once to register the ciphertext with Circle:
 *        npm run circle:register
 *      It writes a recovery file — store it somewhere safe.
 *
 * Re-running registration for an already-registered entity secret will fail;
 * that's expected. You only register once per entity secret.
 */
import "dotenv/config";
import * as path from "path";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

export async function run(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    console.error(
      "ERROR: CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in .env"
    );
    process.exit(1);
  }

  const recoveryFileDownloadPath = path.join(process.cwd(), "data");

  console.log("[circle:register] Registering entity secret ciphertext...");
  try {
    const res = await registerEntitySecretCiphertext({
      apiKey,
      entitySecret,
      recoveryFileDownloadPath,
    });
    console.log("[circle:register] ✓ Registered.");
    console.log(
      `[circle:register] Recovery file written under: ${recoveryFileDownloadPath}`
    );
    if (res.data) {
      console.log(JSON.stringify(res.data, null, 2));
    }
  } catch (err) {
    console.error(
      "[circle:register] Registration failed (this is expected if the entity " +
        "secret was already registered):"
    );
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}
