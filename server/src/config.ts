import "./env.js";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import type { Account, PublicClient, WalletClient } from "viem";
import {
  accountFromEnv,
  getChainConfig,
  makePublicClient,
  makeSmartAccount7702,
  makeWalletClient,
  type ChainConfig,
} from "@brainbudget/shared";

export const chainConfig: ChainConfig = getChainConfig(process.env.CHAIN);
export const networkId = `eip155:${chainConfig.chain.id}` as const;
export const facilitatorUrl =
  process.env.FACILITATOR_URL || chainConfig.facilitatorUrls[0];

export const publicClient: PublicClient = makePublicClient(chainConfig);

export interface Actors {
  userEoa: Account;
  agentEoa: Account;
  gatewayEoa: Account;
  userSmartAccount: MetaMaskSmartAccount;
  agentSmartAccount: MetaMaskSmartAccount;
  agentWallet: WalletClient;
}

let actorsPromise: Promise<Actors> | undefined;

export function getActors(): Promise<Actors> {
  actorsPromise ??= (async () => {
    const userEoa = accountFromEnv("USER_PRIVATE_KEY");
    const agentEoa = accountFromEnv("AGENT_PRIVATE_KEY");
    const gatewayEoa = accountFromEnv("GATEWAY_PRIVATE_KEY");
    return {
      userEoa,
      agentEoa,
      gatewayEoa,
      // 7702-upgraded EOAs: required by the MetaMask x402 facilitator for erc7710.
      userSmartAccount: await makeSmartAccount7702(publicClient, userEoa),
      agentSmartAccount: await makeSmartAccount7702(publicClient, agentEoa),
      agentWallet: makeWalletClient(chainConfig, agentEoa),
    };
  })();
  return actorsPromise;
}

export const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4021);
export const INFERENCE_PRICE = "$0.01";
