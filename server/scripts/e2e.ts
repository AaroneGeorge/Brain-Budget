/**
 * Day 0 end-to-end: the full delegation lifecycle on the configured chain.
 *
 *  1. user EOA → headless Hybrid smart account (deployed if needed)
 *  2. user grants the agent a budget delegation (2 USDC cap, 5 calls, 24h)
 *  3. agent redeems 0.05 USDC via the DelegationManager (plain EOA tx)
 *  4. agent attempts an over-budget redemption → MUST be rejected on-chain
 *
 * Prereqs (Base Sepolia): USER smart account holds test USDC (Circle faucet),
 * AGENT EOA holds a little ETH for gas (any Base Sepolia faucet).
 */
import "../src/env.js";
import { erc20Abi, formatUnits } from "viem";
import {
  accountFromEnv,
  createBudgetDelegation,
  ensureDeployed,
  getChainConfig,
  makePublicClient,
  makeSmartAccount,
  makeWalletClient,
  redeemAsEoaTransfer,
} from "@brainbudget/shared";

const BUDGET_USDC = "2";
const MAX_CALLS = 5;
const CLAIM_USDC = "0.05";
const OVER_BUDGET_USDC = "3"; // > cap, must revert

const config = getChainConfig(process.env.CHAIN);
const publicClient = makePublicClient(config);

const userEoa = accountFromEnv("USER_PRIVATE_KEY");
const agentEoa = accountFromEnv("AGENT_PRIVATE_KEY");
const agentWallet = makeWalletClient(config, agentEoa);

const usdcBalance = (address: `0x${string}`) =>
  publicClient.readContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

async function main() {
  console.log(`chain: ${config.chain.name} (${config.chain.id})`);

  // 1. user smart account
  const userSmartAccount = await makeSmartAccount(publicClient, userEoa);
  console.log(`user smart account: ${userSmartAccount.address}`);
  const deployment = await ensureDeployed(publicClient, userSmartAccount, agentWallet, config.chain);
  console.log(`deployment: ${deployment === "already-deployed" ? deployment : config.explorerTxUrl(deployment)}`);

  const funding = await usdcBalance(userSmartAccount.address);
  console.log(`user smart account USDC: ${formatUnits(funding, 6)}`);
  if (funding === 0n) {
    console.error(`\n✗ Fund the USER SMART ACCOUNT (${userSmartAccount.address}) with test USDC first: https://faucet.circle.com`);
    process.exit(1);
  }

  // 2. budget delegation
  const signedDelegation = await createBudgetDelegation({
    to: agentEoa.address,
    delegator: userSmartAccount,
    usdc: config.usdc,
    maxUsdc: BUDGET_USDC,
    maxCalls: MAX_CALLS,
    validForSeconds: 24 * 3600,
  });
  console.log(`\ndelegation signed: ${BUDGET_USDC} USDC cap, ${MAX_CALLS} calls, 24h`);
  console.log(JSON.stringify(signedDelegation, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  // 3. agent claims a tranche
  const before = await usdcBalance(agentEoa.address);
  const claimTx = await redeemAsEoaTransfer({
    walletClient: agentWallet,
    chain: config.chain,
    config,
    signedDelegation,
    recipient: agentEoa.address,
    amountUsdc: CLAIM_USDC,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: claimTx });
  console.log(`\n✓ redeemed ${CLAIM_USDC} USDC → agent | status=${receipt.status} | ${config.explorerTxUrl(claimTx)}`);
  if (receipt.status !== "success") throw new Error("redemption transaction reverted");

  // Public RPCs are load-balanced; poll until the read catches up to the receipt.
  let after = before;
  for (let attempt = 0; attempt < 10 && after - before !== 50_000n; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    after = await usdcBalance(agentEoa.address);
  }
  if (after - before !== 50_000n) {
    throw new Error("redemption did not transfer the expected amount");
  }

  // 4. over-budget redemption must fail (caveat enforcer, on-chain)
  try {
    await redeemAsEoaTransfer({
      walletClient: agentWallet,
      chain: config.chain,
      config,
      signedDelegation,
      recipient: agentEoa.address,
      amountUsdc: OVER_BUDGET_USDC,
    });
    throw new Error("OVER-BUDGET REDEMPTION WAS NOT REJECTED — caveat not enforced!");
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("NOT REJECTED")) throw error;
    console.log(`\n✓ over-budget redemption (${OVER_BUDGET_USDC} USDC > ${BUDGET_USDC} cap) rejected on-chain, as designed`);
    console.log(`  reason: ${message.split("\n")[0]}`);
  }

  console.log("\nE2E PASSED — delegation lifecycle works.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
