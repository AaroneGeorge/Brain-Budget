import {
  Implementation,
  toMetaMaskSmartAccount,
  type MetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getRpcUrl, type ChainConfig } from "./chains.js";

export function makePublicClient(config: ChainConfig): PublicClient {
  return createPublicClient({
    chain: config.chain,
    transport: http(getRpcUrl(config)),
  });
}

export function makeWalletClient(config: ChainConfig, account: Account): WalletClient {
  return createWalletClient({
    account,
    chain: config.chain,
    transport: http(getRpcUrl(config)),
  });
}

export function accountFromEnv(envVar: string): Account {
  const key = process.env[envVar];
  if (!key || !key.startsWith("0x") || key.length !== 66) {
    throw new Error(`${envVar} missing or malformed in .env — run \`pnpm --filter server script scripts/gen-keys.ts\``);
  }
  return privateKeyToAccount(key as `0x${string}`);
}

/** Headless Hybrid smart account owned by an EOA signer — same shape for user and agent. */
export async function makeSmartAccount(
  publicClient: PublicClient,
  owner: Account,
): Promise<MetaMaskSmartAccount> {
  return toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: "0x",
    signer: { account: owner },
  });
}

/**
 * Deploy a smart account by calling its factory directly from a funded EOA
 * (no bundler/paymaster needed). No-op if already deployed.
 */
export async function ensureDeployed(
  publicClient: PublicClient,
  smartAccount: MetaMaskSmartAccount,
  deployer: WalletClient,
  chain: Chain,
): Promise<"already-deployed" | `0x${string}`> {
  const code = await publicClient.getCode({ address: smartAccount.address });
  if (code && code !== "0x") return "already-deployed";

  const { factory, factoryData } = await smartAccount.getFactoryArgs();
  if (!factory || !factoryData) {
    throw new Error("Smart account undeployed but factory args unavailable");
  }
  const hash = await deployer.sendTransaction({
    account: deployer.account!,
    to: factory,
    data: factoryData,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
