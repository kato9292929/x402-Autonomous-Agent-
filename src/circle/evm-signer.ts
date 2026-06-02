import type { ClientEvmSigner } from "@x402/evm";
import { getCircleClient } from "./client";

/**
 * Circle-backed EVM signer for x402.
 *
 * x402's EIP-3009 "exact" scheme only needs `address` + `signTypedData`
 * (a gasless TransferWithAuthorization — signed off-chain, settled by the
 * facilitator). We satisfy that interface by delegating the EIP-712 signature
 * to Circle's Developer-Controlled Wallets `signTypedData` API, so the private
 * key never leaves Circle's HSM.
 *
 * Replaces the previous `privateKeyToAccount(PAYMENT_PRIVATE_KEY)` signer.
 */

type TypedDataMessage = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

const DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};

/**
 * eth_signTypedData_v4 (which Circle implements) requires an explicit
 * `EIP712Domain` entry in `types`. viem/x402 omit it and derive it internally,
 * so we reconstruct it from whichever domain fields are present, in the
 * canonical order.
 */
function withEip712Domain(message: TypedDataMessage): TypedDataMessage {
  if (message.types.EIP712Domain) return message;

  const domainFields = Object.keys(DOMAIN_FIELD_TYPES)
    .filter((field) => message.domain[field] !== undefined)
    .map((field) => ({ name: field, type: DOMAIN_FIELD_TYPES[field] }));

  return {
    ...message,
    types: { EIP712Domain: domainFields, ...message.types },
  };
}

/** JSON replacer that renders bigints as decimal strings (EIP-712 friendly). */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export interface CircleEvmSignerConfig {
  /** Circle wallet id (UUID). Defaults to CIRCLE_EVM_WALLET_ID. */
  walletId?: string;
  /** EVM address of the wallet. Defaults to CIRCLE_EVM_WALLET_ADDRESS. */
  address?: `0x${string}`;
}

/**
 * Builds a {@link ClientEvmSigner} whose `signTypedData` is served by Circle.
 *
 * The wallet id + address come from config or the CIRCLE_EVM_WALLET_ID /
 * CIRCLE_EVM_WALLET_ADDRESS env vars (produced by `npm run circle:setup`).
 */
export function createCircleEvmSigner(
  config: CircleEvmSignerConfig = {}
): ClientEvmSigner {
  const walletId = config.walletId ?? process.env.CIRCLE_EVM_WALLET_ID;
  const address = (config.address ??
    process.env.CIRCLE_EVM_WALLET_ADDRESS) as `0x${string}` | undefined;

  if (!walletId) {
    throw new Error(
      "CIRCLE_EVM_WALLET_ID is required to build the Circle EVM signer. " +
        "Run `npm run circle:setup` to create a wallet."
    );
  }
  if (!address) {
    throw new Error(
      "CIRCLE_EVM_WALLET_ADDRESS is required to build the Circle EVM signer. " +
        "Run `npm run circle:setup` to create a wallet."
    );
  }

  const client = getCircleClient();

  return {
    address,
    async signTypedData(message): Promise<`0x${string}`> {
      const data = JSON.stringify(withEip712Domain(message), bigintReplacer);

      const res = await client.signTypedData({ walletId, data });
      const signature = res.data?.signature;

      if (!signature) {
        throw new Error(
          "Circle signTypedData returned no signature (response: " +
            JSON.stringify(res.data) +
            ")"
        );
      }
      return signature as `0x${string}`;
    },
  };
}
