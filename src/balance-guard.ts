/**
 * Pre-flight USDC balance check for both settlement legs.
 *
 * The agent has now been silently drained twice: the Circle DCW Base wallet ran
 * out and every Base endpoint failed with an EIP-3009 revert, and the Solana
 * payer ran out on 2026-08-18 and JIN Movers returned "HTTP 402: {}" every day
 * for a week before anyone noticed. Both looked like protocol errors at the call
 * site, so the balance was the last thing anyone checked.
 *
 * This runs before the daily calls and says the balance out loud, so a low
 * wallet is visible in the log and the webhook rather than being inferred from
 * a week of odd failures.
 *
 * It is advisory only: a failed check never blocks a run. Not knowing the
 * balance is not a reason to skip the day's work.
 */

/** USDC contract on Base mainnet (6 decimals). */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** USDC mint on Solana mainnet (6 decimals). */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Warn below this many USDC on the Base leg. Roughly five days of spend. */
export const BASE_WARN_USDC = Number(process.env.BALANCE_WARN_BASE_USDC ?? "10");
/** Warn below this many USDC on the Solana leg. */
export const SOLANA_WARN_USDC = Number(process.env.BALANCE_WARN_SOLANA_USDC ?? "1");
/**
 * Warn below this many USDC on the weekly external probe's wallet (Base USDC).
 * The probe spends ~$0.4 a week, so $5 is a couple of months of notice — the
 * point is that this wallet is the third drain candidate and must not be left
 * off the guard, which is how the first two failures went unnoticed for a week.
 */
export const PROBE_WARN_USDC = Number(process.env.BALANCE_WARN_PROBE_USDC ?? "5");

export interface LegBalance {
  leg: "base" | "solana" | "probe";
  address?: string;
  /** Balance in USDC. Undefined when it could not be read. */
  usdc?: number;
  threshold: number;
  /** Why the balance could not be read, when it could not. */
  error?: string;
}

export interface BalanceReport {
  legs: LegBalance[];
  /** Human-readable lines for the log and the webhook. Empty when all is well. */
  warnings: string[];
}

/**
 * Turn raw balances into warnings (pure — this is the part worth testing).
 *
 * A leg that could not be read is reported separately from a leg that is low:
 * "unknown" must never be presented as "fine".
 */
export function evaluateBalances(legs: LegBalance[]): string[] {
  const warnings: string[] = [];
  for (const leg of legs) {
    const where = `${leg.leg}${leg.address ? ` (${leg.address.slice(0, 6)}…${leg.address.slice(-4)})` : ""}`;
    if (leg.error) {
      warnings.push(`Could not read ${where} USDC balance: ${leg.error}`);
      continue;
    }
    if (leg.usdc === undefined) {
      warnings.push(`Could not read ${where} USDC balance`);
      continue;
    }
    if (leg.usdc < leg.threshold) {
      warnings.push(
        `LOW BALANCE — ${where} holds ${leg.usdc.toFixed(6)} USDC, below the ` +
          `${leg.threshold} USDC threshold. Payments on this leg will start failing.`
      );
    }
  }
  return warnings;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

/** ERC-20 balanceOf(address) → USDC, via eth_call. */
export async function readBaseUsdc(address: string, rpcUrl: string): Promise<number> {
  // balanceOf(address) selector + 32-byte padded address
  const data = "0x70a08231" + address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const hex = await rpc<string>(rpcUrl, "eth_call", [{ to: BASE_USDC, data }, "latest"]);
  return Number(BigInt(hex)) / 1e6;
}

/** Sum of the owner's USDC token accounts. */
export async function readSolanaUsdc(owner: string, rpcUrl: string): Promise<number> {
  const result = await rpc<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }>;
  }>(rpcUrl, "getTokenAccountsByOwner", [
    owner,
    { mint: SOLANA_USDC_MINT },
    { encoding: "jsonParsed" },
  ]);
  return (result.value ?? []).reduce(
    (sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
    0
  );
}

/**
 * Read both legs. Never throws — an unreadable balance becomes a warning.
 * Addresses come from the same env the payment path uses, so a wallet mix-up
 * shows up here as a balance that does not match expectations.
 */
export async function checkBalances(solanaAddress?: string): Promise<BalanceReport> {
  const legs: LegBalance[] = [];

  const baseAddress =
    process.env.SIGNER_BACKEND === "circle"
      ? process.env.CIRCLE_EVM_WALLET_ADDRESS
      : process.env.WALLET_ADDRESS;
  const baseLeg: LegBalance = { leg: "base", address: baseAddress, threshold: BASE_WARN_USDC };
  if (!baseAddress) {
    baseLeg.error = "no wallet address configured";
  } else {
    try {
      baseLeg.usdc = await readBaseUsdc(
        baseAddress,
        process.env.BASE_RPC_URL ?? "https://mainnet.base.org"
      );
    } catch (err) {
      baseLeg.error = err instanceof Error ? err.message : String(err);
    }
  }
  legs.push(baseLeg);

  const svmAddress = solanaAddress ?? process.env.SOLANA_WALLET_ADDRESS;
  const svmLeg: LegBalance = { leg: "solana", address: svmAddress, threshold: SOLANA_WARN_USDC };
  if (!svmAddress) {
    svmLeg.error = "no wallet address configured";
  } else {
    try {
      svmLeg.usdc = await readSolanaUsdc(
        svmAddress,
        process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
      );
    } catch (err) {
      svmLeg.error = err instanceof Error ? err.message : String(err);
    }
  }
  legs.push(svmLeg);

  // Weekly external probe wallet (Base USDC), kept separate from production
  // funds. Only checked once it exists — an unconfigured wallet would otherwise
  // warn every day and train everyone to ignore the warnings.
  const probeAddress = process.env.CIRCLE_PROBE_WALLET_ADDRESS;
  if (probeAddress) {
    const probeLeg: LegBalance = { leg: "probe", address: probeAddress, threshold: PROBE_WARN_USDC };
    try {
      probeLeg.usdc = await readBaseUsdc(
        probeAddress,
        process.env.BASE_RPC_URL ?? "https://mainnet.base.org"
      );
    } catch (err) {
      probeLeg.error = err instanceof Error ? err.message : String(err);
    }
    legs.push(probeLeg);
  }

  return { legs, warnings: evaluateBalances(legs) };
}

/** Log the report; returns the warnings so callers can forward them. */
export async function logBalances(solanaAddress?: string): Promise<string[]> {
  const report = await checkBalances(solanaAddress);
  for (const leg of report.legs) {
    const value = leg.usdc !== undefined ? `${leg.usdc.toFixed(6)} USDC` : `unknown (${leg.error})`;
    console.log(`[BALANCE] ${leg.leg}: ${value}${leg.address ? ` — ${leg.address}` : ""}`);
  }
  for (const w of report.warnings) console.warn(`[BALANCE] ⚠️  ${w}`);
  return report.warnings;
}
