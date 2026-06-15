/**
 * Step 1-3: Set agentURI on IdentityRegistry after registration file is live.
 *
 * Run in Railway Console:
 *   node dist/scripts/erc8004-set-uri.js
 *
 * Prerequisites:
 *   - ERC8004_AGENT_ID set in Railway Variables
 *   - /.well-known/agent-card.json must be reachable (deployed)
 *   - CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_EVM_WALLET_ID set
 *   - Circle EVM wallet funded with ETH on Base for gas
 */
import { setAgentURI } from "../erc8004/executor";

const RAILWAY_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "https://x402-autonomous-agent-production.up.railway.app";

async function main(): Promise<void> {
  const agentIdStr = process.env.ERC8004_AGENT_ID;
  if (!agentIdStr) throw new Error("ERC8004_AGENT_ID env var is required");
  const agentId = BigInt(agentIdStr);

  const uri = `${RAILWAY_URL}/.well-known/agent-card.json`;

  console.log(`\n=== ERC-8004 setAgentURI ===`);
  console.log(`agentId: ${agentId}`);
  console.log(`uri:     ${uri}`);

  const txHash = await setAgentURI(agentId, uri);
  console.log(`\nDone. txHash=${txHash}`);
  console.log("Run erc8004-verify.js to confirm on-chain state.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
