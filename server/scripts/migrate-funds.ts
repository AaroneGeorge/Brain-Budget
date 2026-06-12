/**
 * One-off: move USDC out of the old Hybrid user smart account to the user EOA
 * (which becomes the 7702-upgraded smart account). Uses a delegation redemption —
 * the same mechanism the product is built on.
 */
import "../src/env.js";
import { erc20Abi, formatUnits } from "viem";
import {
  accountFromEnv,
  createBudgetDelegation,
  getChainConfig,
  makePublicClient,
  makeSmartAccount,
  makeWalletClient,
  redeemAsEoaTransfer,
} from "@brainbudget/shared";

const config = getChainConfig(process.env.CHAIN);
const publicClient = makePublicClient(config);
const userEoa = accountFromEnv("USER_PRIVATE_KEY");
const agentEoa = accountFromEnv("AGENT_PRIVATE_KEY");
const agentWallet = makeWalletClient(config, agentEoa);

const oldHybrid = await makeSmartAccount(publicClient, userEoa);
const balance = await publicClient.readContract({
  address: config.usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [oldHybrid.address],
});
console.log(`old hybrid SA ${oldHybrid.address}: ${formatUnits(balance, 6)} USDC`);
if (balance === 0n) {
  console.log("nothing to migrate");
  process.exit(0);
}

const amount = formatUnits(balance, 6);
const delegation = await createBudgetDelegation({
  to: agentEoa.address,
  delegator: oldHybrid,
  usdc: config.usdc,
  maxUsdc: amount,
  maxCalls: 2,
  validForSeconds: 3600,
});
const hash = await redeemAsEoaTransfer({
  walletClient: agentWallet,
  chain: config.chain,
  config,
  signedDelegation: delegation,
  recipient: userEoa.address,
  amountUsdc: amount,
});
await publicClient.waitForTransactionReceipt({ hash });
console.log(`migrated ${amount} USDC -> user EOA ${userEoa.address}: ${config.explorerTxUrl(hash)}`);
