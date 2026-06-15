/**
 * Step 1-1: Register AA with ERC-8004 IdentityRegistry on Base mainnet.
 *
 * Run in Railway Console after deploy:
 *   node dist/scripts/erc8004-register.js
 *
 * Prerequisites:
 *   - CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_EVM_WALLET_ID set in env
 *   - Circle EVM wallet funded with ETH on Base for gas
 *
 * Output:
 *   ERC8004_AGENT_ID=<number>
 *   Add this to Railway Variables, then redeploy so /.well-known/agent-card.json is live.
 *   After that, run erc8004-set-uri.js to link the URI on-chain.
 */
import { verifyContractExists } from "../erc8004/reader";
import { registerAgent } from "../erc8004/executor";
import { IDENTITY_REGISTRY } from "../erc8004/contract";

async function main(): Promise<void> {
  console.log(`\n=== ERC-8004 Registration ===`);
  console.log(`IdentityRegistry: ${IDENTITY_REGISTRY} (Base mainnet)`);

  console.log("\n[1/3] Verifying IdentityRegistry bytecode...");
  const exists = await verifyContractExists();
  if (!exists) throw new Error("IdentityRegistry has no bytecode at this address — wrong address?");
  console.log("      Contract verified.");

  console.log("\n[2/3] Calling register() via Circle DCW...");
  const agentId = await registerAgent();

  console.log("\n[3/3] Done.\n");
  console.log("=".repeat(50));
  console.log(`ERC8004_AGENT_ID=${agentId}`);
  console.log("=".repeat(50));
  console.log("\nNext steps:");
  console.log("1. Add ERC8004_AGENT_ID to Railway Variables");
  console.log("2. Redeploy so /.well-known/agent-card.json is live");
  console.log("3. Run: node dist/scripts/erc8004-set-uri.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
