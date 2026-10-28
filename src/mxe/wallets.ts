/**
 * The MXE agent wallets, found in Circle by refId instead of being copied into
 * configuration. `npm run mxe:setup` creates them (idempotently, by the same
 * refIds); the job looks them up at start, so the only things a deployment has
 * to hold are the API keys.
 *
 * An explicit `CIRCLE_MXE_<ROLE>_WALLET_ID` / `_WALLET_ADDRESS` still wins.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

type Client = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

export interface AgentSpec {
  env: string;
  refId: string;
  role: string;
  /** USDC to hold, when setup is run with --fund. */
  fund?: string;
}

export const LIVE_AGENTS: AgentSpec[] = [
  { env: "CIRCLE_MXE_SELLER_A", refId: "aa-mxe-seller-a", role: "内部の売り手 A(機能1・2・4)", fund: "0.01" },
  { env: "CIRCLE_MXE_SELLER_B", refId: "aa-mxe-seller-b", role: "内部の売り手 B(機能2)", fund: "0.01" },
  { env: "CIRCLE_MXE_BUYER_A", refId: "aa-mxe-buyer-a", role: "内部の買い手 A(機能1・2・4)", fund: "0.10" },
  { env: "CIRCLE_MXE_BUYER_B", refId: "aa-mxe-buyer-b", role: "内部の買い手 B(機能4)", fund: "0.10" },
];

export const DEVNET_QUEUER: AgentSpec = {
  env: "CIRCLE_MXE_DEVNET_QUEUER",
  refId: "aa-mxe-devnet-queuer",
  role: "devnet で MXE の計算を投入する署名者",
};

/** The wallet with this refId on this chain, in any wallet set. */
export async function findWalletByRef(
  client: Pick<Client, "listWallets">,
  refId: string,
  blockchain: "SOL" | "SOL-DEVNET"
): Promise<{ id: string; address: string; walletSetId?: string } | undefined> {
  const res = await client.listWallets({ refId, blockchain });
  const w = res.data?.wallets?.find((x) => x.refId === refId) ?? res.data?.wallets?.[0];
  return w?.id && w.address ? { id: w.id, address: w.address, walletSetId: w.walletSetId } : undefined;
}

/**
 * Fill in the agent wallet env vars that are not set, from Circle. Returns one
 * line per role saying where its wallet came from (or that it was not found);
 * a role left unset makes the functions that need it fail, recorded as such.
 */
export async function hydrateAgentWallets(
  env: NodeJS.ProcessEnv = process.env,
  clients: { live?: Pick<Client, "listWallets">; test?: Pick<Client, "listWallets"> } = {}
): Promise<string[]> {
  const live =
    clients.live ??
    (env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET
      ? initiateDeveloperControlledWalletsClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET })
      : undefined);
  const test =
    clients.test ??
    (env.CIRCLE_API_KEY_TEST && env.CIRCLE_ENTITY_SECRET_TEST
      ? initiateDeveloperControlledWalletsClient({ apiKey: env.CIRCLE_API_KEY_TEST, entitySecret: env.CIRCLE_ENTITY_SECRET_TEST })
      : undefined);

  const notes: string[] = [];
  const roles: [AgentSpec, typeof live, "SOL" | "SOL-DEVNET"][] = [
    ...LIVE_AGENTS.map((s) => [s, live, "SOL"] as [AgentSpec, typeof live, "SOL"]),
    [DEVNET_QUEUER, test, "SOL-DEVNET"],
  ];
  for (const [spec, client, chain] of roles) {
    if (env[`${spec.env}_WALLET_ID`] && env[`${spec.env}_WALLET_ADDRESS`]) {
      notes.push(`${spec.refId}: from env`);
      continue;
    }
    if (!client) {
      notes.push(`${spec.refId}: not found (no Circle ${chain === "SOL" ? "LIVE" : "TEST"} credentials)`);
      continue;
    }
    try {
      const w = await findWalletByRef(client, spec.refId, chain);
      if (!w) {
        notes.push(`${spec.refId}: not found in Circle — run the mxe-setup workflow`);
        continue;
      }
      env[`${spec.env}_WALLET_ID`] = w.id;
      env[`${spec.env}_WALLET_ADDRESS`] = w.address;
      notes.push(`${spec.refId}: ${w.address}`);
    } catch (err) {
      notes.push(`${spec.refId}: lookup failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return notes;
}
