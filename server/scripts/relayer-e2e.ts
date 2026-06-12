/**
 * 1Shot relayer e2e: the agent claims a 0.02 USDC tranche from the user's
 * account through the permissionless relayer — zero ETH involved, gas paid
 * from the user's USDC inside the same delegation bundle.
 */
import "../src/env.js";
import { erc20Abi, formatUnits } from "viem";
import { chainConfig, getActors, publicClient } from "../src/config.js";
import { claimBudgetViaRelayer, waitForRelayerTask } from "../src/relayer.js";

const { userSmartAccount, agentSmartAccount } = await getActors();

const balance = (address: `0x${string}`) =>
  publicClient.readContract({
    address: chainConfig.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

const before = await balance(agentSmartAccount.address);
console.log(`relayer: ${chainConfig.oneShotRelayerUrl}`);
console.log(`agent USDC before: ${formatUnits(before, 6)}`);

const claim = await claimBudgetViaRelayer({
  userSmartAccount,
  recipient: agentSmartAccount.address,
  amountUsdc: "0.02",
  memo: "brainbudget-relayer-e2e",
});
console.log(`task submitted: ${claim.taskId} | fee: ${formatUnits(BigInt(claim.feeUsdcAtoms), 6)} USDC | target: ${claim.targetAddress}`);

const status = await waitForRelayerTask(claim.taskId);
console.log(`final status: ${status.status} ${status.status === 200 ? "(confirmed)" : ""}`);
if (status.hash) console.log(`tx: ${chainConfig.explorerTxUrl(String(status.hash))}`);

if (status.status !== 200) {
  console.error("✗ relayer task did not confirm:", JSON.stringify(status).slice(0, 400));
  process.exit(1);
}

let after = before;
for (let i = 0; i < 10 && after - before !== 20_000n; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  after = await balance(agentSmartAccount.address);
}
console.log(`agent USDC after: ${formatUnits(after, 6)}`);
if (after - before !== 20_000n) {
  console.error("✗ agent did not receive the claimed tranche");
  process.exit(1);
}
console.log("\nRELAYER E2E PASSED — gasless budget claim via 1Shot, fee paid in USDC.");
