import { AgentKit, CdpWalletProvider } from "@coinbase/agentkit";

let _agentkit: AgentKit | null = null;
let _walletProvider: CdpWalletProvider | null = null;

export async function initializeWallet(): Promise<AgentKit> {
  _walletProvider = await CdpWalletProvider.configureWithWallet({
    apiKeyName: process.env.CDP_API_KEY_NAME!,
    apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY!,
    networkId: "base-mainnet",
    cdpWalletData: process.env.WALLET_DATA,
  });

  _agentkit = await AgentKit.from({
    walletProvider: _walletProvider,
    actionProviders: [],
  });

  const address = _walletProvider.getAddress();
  console.log(`Agent wallet initialized: ${address}`);

  return _agentkit;
}

export function getAgentKit(): AgentKit {
  if (!_agentkit) {
    throw new Error("AgentKit not initialized. Call initializeWallet() first.");
  }
  return _agentkit;
}

export function getWalletProvider(): CdpWalletProvider {
  if (!_walletProvider) {
    throw new Error("Wallet not initialized. Call initializeWallet() first.");
  }
  return _walletProvider;
}
