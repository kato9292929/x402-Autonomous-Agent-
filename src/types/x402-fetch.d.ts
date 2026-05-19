declare module "x402-fetch" {
  export type Signer = unknown;

  export function createSigner(
    network: string,
    privateKey: string
  ): Promise<Signer>;

  export function wrapFetchWithPayment(
    fetchFn: typeof globalThis.fetch,
    signer: Signer,
    maxValue?: bigint
  ): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}
