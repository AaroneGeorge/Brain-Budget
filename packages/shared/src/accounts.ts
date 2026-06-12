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
 * EIP-7702 smart account: the EOA itself, upgraded to EIP7702StatelessDeleGator.
 * Required by the MetaMask x402 facilitator for erc7710 delegators.
 */
export async function makeSmartAccount7702(
  publicClient: PublicClient,
  owner: Account,
): Promise<MetaMaskSmartAccount> {
  return toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address: owner.address,
    signer: { account: owner },
  });
}

/**
 * Upgrade an EOA to EIP7702StatelessDeleGator via a sponsored type-4 transaction:
 * `owner` signs the authorization, `submitter` pays the gas. No-op if already upgraded.
 */
export async function ensure7702Upgraded(opts: {
  publicClient: PublicClient;
  owner: Account;
  submitter: WalletClient;
  chain: Chain;
  delegatorImpl: `0x${string}`;
}): Promise<"already-upgraded" | `0x${string}`> {
  const expectedCode = `0xef0100${opts.delegatorImpl.slice(2).toLowerCase()}`;
  const code = await opts.publicClient.getCode({ address: opts.owner.address });
  if (code?.toLowerCase() === expectedCode) return "already-upgraded";

  const selfExecuting = opts.submitter.account?.address === opts.owner.address;
  const authorization = await opts.submitter.signAuthorization({
    account: opts.owner,
    contractAddress: opts.delegatorImpl,
    // When the authorizing EOA submits its own type-4 tx, the authorization nonce
    // must be bumped past the tx nonce or it is silently skipped.
    ...(selfExecuting ? { executor: "self" as const } : {}),
  });
  const hash = await opts.submitter.sendTransaction({
    account: opts.submitter.account!,
    authorizationList: [authorization],
    to: opts.owner.address,
    data: "0x",
    chain: opts.chain,
  });
  await opts.publicClient.waitForTransactionReceipt({ hash });
  return hash;
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
