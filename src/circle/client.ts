import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";

/**
 * Circle Developer-Controlled Wallets client (memoized).
 *
 * Requires two secrets, supplied via environment variables only — never hardcoded:
 *   - CIRCLE_API_KEY:       Circle Developer Console API key
 *   - CIRCLE_ENTITY_SECRET: 32-byte hex entity secret (must be registered once
 *                           via `npm run circle:register`)
 *
 * Optional:
 *   - CIRCLE_BASE_URL:      override the API base URL (defaults to Circle prod)
 */
let _client: CircleDeveloperControlledWalletsClient | null = null;

export function getCircleClient(): CircleDeveloperControlledWalletsClient {
  if (_client) return _client;

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey) {
    throw new Error("CIRCLE_API_KEY environment variable is required");
  }
  if (!entitySecret) {
    throw new Error("CIRCLE_ENTITY_SECRET environment variable is required");
  }

  _client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
    ...(process.env.CIRCLE_BASE_URL
      ? { baseUrl: process.env.CIRCLE_BASE_URL }
      : {}),
  });

  return _client;
}

/** True when Circle credentials are present in the environment. */
export function isCircleConfigured(): boolean {
  return Boolean(process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET);
}
