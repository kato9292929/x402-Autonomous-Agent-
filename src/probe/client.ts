/**
 * Payment client for the external probe.
 *
 * Separate from the daily agent client so the probe keeps its own strict spend
 * policy. It pays from the existing Circle Base wallet — the same wallet the
 * daily agent uses — so there is no second balance to fund or watch.
 * Everything else is the existing machinery — wrapFetchWithPayment does the
 * transport, the 402 parsing and the signing. No 402 parser is written here;
 * hand-rolling one is how the JIN diagnosis went wrong (v2 carries the challenge
 * in the PAYMENT-REQUIRED header, v1 in the body).
 *
 * The three ceilings are enforced inside `registerPolicy`, which runs during
 * requirement selection — structurally before anything is signed. A call the
 * budget refuses leaves no requirement to select, so the library aborts instead
 * of paying.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { registerExactSvmScheme, ExactSvmScheme } from "@x402/svm/exact/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createCircleEvmSigner } from "../circle/evm-signer";
import { getCircleSolanaSignerFromEnv } from "../circle/solana-signer";
import { priceOf } from "../payment-guard";
import { allowsCall, PER_CALL_CAP_USD, PER_RUN_CAP_USD, WEEKLY_CAP_USD } from "./budget";

/** Solana mainnet, CAIP-2. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Base, as v2 CAIP-2 and the v1 alias. */
export const BASE_NETWORKS = ["eip155:8453", "base"];
/** Solana, as v2 CAIP-2 and the v1 alias the SVM scheme registers. */
export const SOLANA_NETWORKS = [SOLANA_MAINNET, "solana"];

/**
 * Networks the probe wallet can settle on.
 *
 * Base only until 2026-10-20. On that date 2s and Otto AI were both found to be
 * offering a Solana leg they had not offered on 2026-09-18, and a Solana-only
 * seller was recorded as `skipped` ("対応チェーンなし") rather than measured. The
 * agent already holds a Circle Solana wallet, so the leg is registered when that
 * wallet is configured and the list narrows back to Base when it is not — a
 * network we cannot sign for must not be counted as payable, or `observe` quotes
 * a price the sweep then fails to pay.
 */
export function probeNetworks(): string[] {
  return solanaConfigured() ? [...BASE_NETWORKS, ...SOLANA_NETWORKS] : [...BASE_NETWORKS];
}

/**
 * Kept as a constant for the callers that only need the Base list, and because
 * the discovery path runs without a wallet at all.
 *
 * @deprecated Use `probeNetworks()`, which reflects the configured signers.
 */
export const PROBE_NETWORKS = BASE_NETWORKS;

function solanaConfigured(): boolean {
  return getCircleSolanaSignerFromEnv() !== undefined;
}

/**
 * Which network to settle on when a seller offers more than one we can pay.
 *
 * Unset keeps the library's default (`accepts[0]`), which is what every
 * measurement so far was taken with. Setting it to a CAIP-2 id makes the sweep
 * prefer that chain, so the same route can be measured on Base and on Solana and
 * the real per-call cost compared. The preference is applied after the budget
 * policy, so it can never reach past a ceiling.
 */
export function preferredNetwork(): string | undefined {
  const v = process.env.PROBE_PREFER_NETWORK?.trim();
  return v ? v : undefined;
}

/**
 * Which of several legs on the same network to take.
 *
 * A network is not always enough to name a leg. Exa offers two on Arc —
 * `arc-usdc-gateway` (Circle Gateway, prefunded) and `arc-usdc-circle`
 * (EIP-3009, what this wallet signs) — both `eip155:5042`, both `exact`. Naming
 * only the network would pick whichever came first.
 *
 * Matched against `extra.acceptId`, which is the seller's own label for the leg.
 */
export function preferredAcceptId(): string | undefined {
  const v = process.env.PROBE_PREFER_ACCEPT_ID?.trim();
  return v ? v : undefined;
}

function acceptIdOf(r: PaymentRequirements): string | undefined {
  const extra = (r as { extra?: Record<string, unknown> }).extra;
  const id = extra?.acceptId;
  return typeof id === "string" ? id : undefined;
}

/**
 * True when `ExactEvmScheme` can actually produce a valid signature for this leg.
 *
 * The scheme builds its EIP-712 domain as `{ name, version }` from `extra` with
 * `verifyingContract` set to the **asset** address
 * (@x402/evm chunk-TRL63EE2.mjs:93). A leg that names a different settlement
 * contract — Circle Gateway's `GatewayWalletBatched` at
 * 0x77777777dcc4d5a8b6e418fd04d8997ef11000ee, which Exa offers on Base, World
 * Chain and Arc — would therefore be signed over a domain that matches neither
 * the token nor the Gateway, and the facilitator rejects it.
 *
 * That fails closed, so no money moves. But a leg we cannot sign must not be
 * selected, and must not be counted as payable: quoting a price the sweep then
 * cannot pay is exactly the kind of number this probe exists to not produce.
 */
export function isSignableLeg(r: PaymentRequirements): boolean {
  const network = networkOf(r);
  if (!network.startsWith("eip155:")) return true; // Solana legs carry no EIP-712 domain
  const extra = (r as { extra?: Record<string, unknown> }).extra;
  const vc = extra?.verifyingContract;
  if (typeof vc !== "string") return true;
  const asset = String((r as { asset?: unknown }).asset ?? "");
  return vc.toLowerCase() === asset.toLowerCase();
}

export interface ProbeSpend {
  /** USDC spent so far in this sweep. */
  run: number;
  /** USDC spent so far this ISO week (loaded from the persistent store). */
  week: number;
}

export interface ObservedChallenge {
  x402Version: number;
  /** Every network the seller offered. */
  offeredNetworks: string[];
  /** Cheapest price on a network this wallet can pay, in USDC. */
  quotedUsdc?: number;
  accepts: PaymentRequirements[];
}

export interface ProbeClient {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The 402 seen for the most recent request, cleared before each call. */
  takeChallenge: () => ObservedChallenge | undefined;
  walletAddress: string;
  /** Solana payer, when the Circle Solana wallet is configured. */
  solanaAddress?: string;
  /** Networks this client can actually settle on. */
  networks?: string[];
}

function networkOf(r: PaymentRequirements): string {
  return String((r as { network?: unknown }).network ?? "");
}

/** Cheapest requirement we could actually pay, and what was on offer. */
export function observe(
  paymentRequired: PaymentRequired,
  networks: string[] = probeNetworks()
): ObservedChallenge {
  const accepts = paymentRequired.accepts ?? [];
  const payable = accepts
    .filter((r) => networks.includes(networkOf(r)) && isSignableLeg(r))
    .map((r) => priceOf(r))
    .filter((p): p is number => p !== undefined);
  return {
    x402Version: paymentRequired.x402Version,
    offeredNetworks: [...new Set(accepts.map(networkOf))],
    quotedUsdc: payable.length > 0 ? Math.min(...payable) : undefined,
    accepts,
  };
}

/**
 * Selector that prefers one leg, falling back to the library's default.
 *
 * Both filters are optional and combine: a network alone takes the first leg on
 * that chain, an acceptId alone takes that leg wherever it is, and both together
 * name one leg exactly — which is what Arc needs, where `arc-usdc-gateway` and
 * `arc-usdc-circle` share a network and a scheme.
 *
 * Exported for the test: a preference that silently dropped a requirement the
 * policy had already approved would quietly change what we pay.
 */
export function selectPreferred(
  prefer: string | undefined,
  acceptId?: string
): (version: number, reqs: PaymentRequirements[]) => PaymentRequirements {
  return (_version, reqs) => {
    if (prefer || acceptId) {
      const match = reqs.find(
        (r) =>
          (!prefer || networkOf(r) === prefer) && (!acceptId || acceptIdOf(r) === acceptId)
      );
      if (match) return match;
    }
    return reqs[0];
  };
}

/** Build the paying fetch, or null when the Circle Base wallet is not configured. */
export function buildProbeClient(spend: ProbeSpend): ProbeClient | null {
  if (process.env.SIGNER_BACKEND !== "circle") return null;
  const walletId = process.env.CIRCLE_EVM_WALLET_ID;
  const walletAddress = process.env.CIRCLE_EVM_WALLET_ADDRESS;
  if (!walletId || !walletAddress) return null;

  // Circle DCW holds the key; the agent holds a wallet id. No raw key in env.
  const signer = createCircleEvmSigner(walletId, walletAddress as `0x${string}`, "live");
  const scheme = new ExactEvmScheme(signer);

  // The preference runs after the budget policy (@x402/core applies policies,
  // then the selector), so it reorders what is already allowed and cannot
  // reintroduce a requirement a ceiling refused.
  const base = new x402Client(selectPreferred(preferredNetwork(), preferredAcceptId()))
    .register("eip155:8453", scheme)
    .registerV1("base", scheme)
    .registerPolicy((_version: number, reqs: PaymentRequirements[]) =>
      reqs.filter((r) => {
        // A leg this scheme cannot sign is dropped before the budget is even
        // consulted, so it can never be selected — including at accepts[0],
        // where the default selector would otherwise take it.
        if (!isSignableLeg(r)) return false;
        const price = priceOf(r);
        if (price === undefined) return false; // 読めない金額は払わない
        return allowsCall(price, spend.run, spend.week).allowed;
      })
    );

  // Solana leg, from the agent's existing Circle Solana wallet. Registered only
  // when that wallet is configured: an unsigned network left registered would
  // make `observe` quote a price the sweep cannot actually pay.
  const circleSolana = getCircleSolanaSignerFromEnv();
  let solanaAddress: string | undefined;
  if (circleSolana) {
    solanaAddress = circleSolana.address;
    // registerExactSvmScheme builds its v2 instance with no config, so it signs
    // against the default public RPC, which rate-limits server traffic. Register
    // the v2 scheme again with SOLANA_RPC_URL when one is set, exactly as the
    // daily client does (src/x402.ts).
    registerExactSvmScheme(base, { signer: circleSolana.signer });
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (rpcUrl) {
      base.register("solana:*", new ExactSvmScheme(circleSolana.signer, { rpcUrl }));
    } else {
      console.warn(
        "[PROBE] SOLANA_RPC_URL not set — Solana legs would sign against the " +
          "public api.mainnet-beta.solana.com endpoint, which rate-limits server traffic"
      );
    }
  }

  const networks = probeNetworks();
  let last: ObservedChallenge | undefined;
  const http = new x402HTTPClient(base).onPaymentRequired(async (ctx) => {
    last = observe(ctx.paymentRequired, networks);
    // No headers returned → proceed to the normal payment path.
  });

  const paying = wrapFetchWithPayment(fetch, http);
  return {
    fetch: paying,
    takeChallenge: () => {
      const c = last;
      last = undefined;
      return c;
    },
    walletAddress,
    solanaAddress,
    networks,
  };
}

/** One-line description of the ceilings, for the run header. */
export function capsSummary(): string {
  return `per-call $${PER_CALL_CAP_USD.toFixed(2)} / run $${PER_RUN_CAP_USD.toFixed(
    2
  )} / week $${WEEKLY_CAP_USD.toFixed(2)}`;
}
