import {
  createDelegation,
  createExecution,
  CaveatType,
  ExecutionMode,
  ScopeType,
  getSmartAccountsEnvironment,
  type Delegation,
  type MetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { encodeFunctionData, erc20Abi, parseUnits, type WalletClient, type Chain } from "viem";
import type { ChainConfig } from "./chains.js";

export interface BudgetDelegationParams {
  /** Delegate address (the agent). */
  to: `0x${string}`;
  delegator: MetaMaskSmartAccount;
  usdc: `0x${string}`;
  /** Budget in whole USDC, e.g. "5". */
  maxUsdc: string;
  maxCalls: number;
  validForSeconds: number;
}

export type SignedDelegation = Delegation & { signature: `0x${string}` };

/**
 * The core trust artifact: ERC-20 transfer-amount scope (budget cap) constrained
 * by limitedCalls and timestamp caveats. Fails closed at the contract level.
 */
export async function createBudgetDelegation(
  params: BudgetDelegationParams,
): Promise<SignedDelegation> {
  const now = Math.floor(Date.now() / 1000);
  const delegation = createDelegation({
    to: params.to,
    from: params.delegator.address,
    environment: params.delegator.environment,
    scope: {
      type: ScopeType.Erc20TransferAmount,
      tokenAddress: params.usdc,
      maxAmount: parseUnits(params.maxUsdc, 6),
    },
    caveats: [
      { type: CaveatType.LimitedCalls, limit: params.maxCalls },
      {
        type: CaveatType.Timestamp,
        afterThreshold: 0,
        beforeThreshold: now + params.validForSeconds,
      },
    ],
  });

  const signature = await params.delegator.signDelegation({ delegation });
  return { ...delegation, signature };
}

export interface SubDelegationParams {
  /** Sub-delegate address (e.g. the critic agent). */
  to: `0x${string}`;
  /** The redelegating agent — must be the delegate of the parent. */
  delegator: MetaMaskSmartAccount;
  parentDelegation: SignedDelegation;
  usdc: `0x${string}`;
  /** Narrowed budget in whole USDC — must be <= the parent's remaining cap. */
  maxUsdc: string;
  maxCalls: number;
  validForSeconds: number;
}

/**
 * A2A redelegation: the agent narrows its own delegated authority and hands a
 * sub-budget to another agent. authority = hash(parent), so the chain only
 * redeems if every hop's caveats pass — the sub-agent can never exceed what
 * the original user granted.
 */
export async function createSubDelegation(
  params: SubDelegationParams,
): Promise<SignedDelegation> {
  const now = Math.floor(Date.now() / 1000);
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  const delegation = createDelegation({
    to: params.to,
    from: params.delegator.address,
    environment: params.delegator.environment,
    parentDelegation: params.parentDelegation,
    salt: `0x${Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    scope: {
      type: ScopeType.Erc20TransferAmount,
      tokenAddress: params.usdc,
      maxAmount: parseUnits(params.maxUsdc, 6),
    },
    caveats: [
      { type: CaveatType.LimitedCalls, limit: params.maxCalls },
      {
        type: CaveatType.Timestamp,
        afterThreshold: 0,
        beforeThreshold: now + params.validForSeconds,
      },
    ],
  });

  const signature = await params.delegator.signDelegation({ delegation });
  return { ...delegation, signature };
}

/** Calldata for redeeming a delegation as a USDC transfer of `amountUsdc` to `recipient`. */
export function encodeUsdcRedemption(
  signedDelegation: SignedDelegation,
  usdc: `0x${string}`,
  recipient: `0x${string}`,
  amountUsdc: string,
): `0x${string}` {
  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, parseUnits(amountUsdc, 6)],
  });
  const executions = [createExecution({ target: usdc, callData: transferCalldata })];
  return DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    // Several caveats are incompatible with batch modes (workshop gotcha) — always SingleDefault.
    modes: [ExecutionMode.SingleDefault],
    executions: [executions],
  });
}

/** Redeem from an EOA delegate as a plain transaction to the DelegationManager. */
export async function redeemAsEoaTransfer(opts: {
  walletClient: WalletClient;
  chain: Chain;
  config: ChainConfig;
  signedDelegation: SignedDelegation;
  recipient: `0x${string}`;
  amountUsdc: string;
}): Promise<`0x${string}`> {
  const data = encodeUsdcRedemption(
    opts.signedDelegation,
    opts.config.usdc,
    opts.recipient,
    opts.amountUsdc,
  );
  return opts.walletClient.sendTransaction({
    account: opts.walletClient.account!,
    to: getSmartAccountsEnvironment(opts.chain.id).DelegationManager,
    data,
    chain: opts.chain,
  });
}
