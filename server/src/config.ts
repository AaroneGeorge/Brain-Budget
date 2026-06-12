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
  criticEoa: Account | undefined;
  userSmartAccount: MetaMaskSmartAccount;
  agentSmartAccount: MetaMaskSmartAccount;
  criticSmartAccount: MetaMaskSmartAccount | undefined;
  agentWallet: WalletClient;
}

let actorsPromise: Promise<Actors> | undefined;

export function getActors(): Promise<Actors> {
  actorsPromise ??= (async () => {
    const userEoa = accountFromEnv("USER_PRIVATE_KEY");
    const agentEoa = accountFromEnv("AGENT_PRIVATE_KEY");
    const gatewayEoa = accountFromEnv("GATEWAY_PRIVATE_KEY");
    // optional A2A sub-agent
    const criticEoa = process.env.CRITIC_PRIVATE_KEY
      ? accountFromEnv("CRITIC_PRIVATE_KEY")
      : undefined;
    return {
      userEoa,
      agentEoa,
      gatewayEoa,
      criticEoa,
      // 7702-upgraded EOAs: required by the MetaMask x402 facilitator for erc7710.
      userSmartAccount: await makeSmartAccount7702(publicClient, userEoa),
      agentSmartAccount: await makeSmartAccount7702(publicClient, agentEoa),
      criticSmartAccount: criticEoa
        ? await makeSmartAccount7702(publicClient, criticEoa)
        : undefined,
      agentWallet: makeWalletClient(chainConfig, agentEoa),
    };
  })();
  return actorsPromise;
}

export const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4021);
export const INFERENCE_PRICE = "$0.01";
