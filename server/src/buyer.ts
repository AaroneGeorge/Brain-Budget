import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Erc7710Client } from "@metamask/x402";
import { createx402DelegationProvider } from "@metamask/smart-accounts-kit/experimental";
import { encodeDelegations } from "@metamask/smart-accounts-kit/utils";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import type { SignedDelegation } from "@brainbudget/shared";

export interface PaymentEvent {
  at: string;
  url: string;
  status: number;
  paymentResponse?: string;
  /** settlement tx hash decoded from the PAYMENT-RESPONSE header, if present */
  txHash?: string;
}

/** PAYMENT-RESPONSE is base64-encoded JSON: { success, transaction, network, payer } */
function decodeSettlementTx(header: string): string | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      transaction?: string;
    };
    return typeof decoded.transaction === "string" ? decoded.transaction : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Payment-aware fetch for an agent. On a 402, the provider REDELEGATES the
 * delegation chain rooted at the user's budget down to exactly the required
 * amount and hands the encoded chain to the facilitator. Two hops for the
 * orchestrator (user -> agent -> payment), three for an A2A sub-agent
 * (user -> agent -> critic -> payment). No agent ever holds the user's funds.
 */
export function makePaidFetch(opts: {
  agentSmartAccount: MetaMaskSmartAccount;
  /** leaf-first: [delegation to agentSmartAccount, ..., root user delegation] */
  delegationChain: SignedDelegation[];
  onPayment?: (event: PaymentEvent) => void;
}): typeof fetch {
  const erc7710Client = new x402Erc7710Client({
    delegationProvider: createx402DelegationProvider({
      account: opts.agentSmartAccount,
      parentPermissionContext: encodeDelegations(opts.delegationChain),
    }),
  });

  const coreClient = new x402Client().register("eip155:*", erc7710Client);
  const httpClient = new x402HTTPClient(coreClient);
  const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

  return async (input, init) => {
    const response = await fetchWithPayment(input, init);
    const paymentResponse = response.headers.get("PAYMENT-RESPONSE") ?? undefined;
    if (paymentResponse) {
      opts.onPayment?.({
        at: new Date().toISOString(),
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        status: response.status,
        paymentResponse,
        txHash: decodeSettlementTx(paymentResponse),
      });
    }
    return response;
  };
}
