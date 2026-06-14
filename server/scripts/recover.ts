/**
 * EMERGENCY RECOVERY TOOL — sweep USDC out of any BrainBudget account back to a
 * wallet you control, with ZERO ETH required.
 *
 * This is the answer to "can my funds get stuck?". No. Every funded address is a
 * plain EOA whose private key lives in .env. This tool proves the harshest case:
 * a 7702-upgraded account holding USDC with no ETH at all is still fully drainable,
 * gaslessly, via the 1Shot relayer (fee paid in USDC). If the account isn't
 * upgraded yet, the upgrade authorization is bundled into the same task.
 *
 * Usage:
 *   RECOVER_FROM=user RECOVER_TO=0xYourSafeWallet npx tsx scripts/recover.ts
 *   RECOVER_FROM=gateway RECOVER_TO=0x... RECOVER_AMOUNT=5 npx tsx scripts/recover.ts
 *
 * RECOVER_FROM : user | agent | gateway | critic   (which .env key holds the funds)
 * RECOVER_TO   : destination address (defaults to printing an error if unset)
 * RECOVER_AMOUNT (optional): whole USDC to move; default = full balance minus a
 *                small reserve to cover the relayer fee.
 *
 * Belt-and-suspenders alternative (no relayer, any wallet): import the .env private
 * key into MetaMask/Rabby, add a few cents of ETH for gas, send the USDC. A 7702
 * EOA signs ordinary outbound transfers exactly like a normal EOA — the code at the
 * address never blocks the owner key.
 */
import "../src/env.js";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { build7702AuthorizationEntry, makeSmartAccount7702 } from "@brainbudget/shared";
import { chainConfig, publicClient } from "../src/config.js";
import { accountFromEnv } from "@brainbudget/shared";
import { claimBudgetViaRelayer, relayerTxHash, waitForRelayerTask } from "../src/relayer.js";

const FROM = (process.env.RECOVER_FROM ?? "user").toLowerCase();
const TO = process.env.RECOVER_TO as `0x${string}` | undefined;
const RESERVE = "0.02"; // leave enough USDC dust to cover the ~$0.01 relayer fee

const KEY_ENV: Record<string, string> = {
  user: "USER_PRIVATE_KEY",
  agent: "AGENT_PRIVATE_KEY",
  gateway: "GATEWAY_PRIVATE_KEY",
  critic: "CRITIC_PRIVATE_KEY",
};

if (!TO || !TO.startsWith("0x") || TO.length !== 42) {
  console.error("✗ set RECOVER_TO=0x<destination wallet you control>");
  process.exit(1);
}
const keyEnv = KEY_ENV[FROM];
if (!keyEnv) {
  console.error(`✗ RECOVER_FROM must be one of: ${Object.keys(KEY_ENV).join(", ")}`);
  process.exit(1);
}

const owner = accountFromEnv(keyEnv);
const sa = await makeSmartAccount7702(publicClient, owner);
console.log(`chain:       ${chainConfig.chain.name} (${chainConfig.chain.id})`);
console.log(`recover from ${FROM} ${owner.address}`);
console.log(`recover to   ${TO}`);

const balance = await publicClient.readContract({
  address: chainConfig.usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [owner.address],
});
console.log(`source USDC: ${formatUnits(balance, 6)}`);
if (balance === 0n) {
  console.log("nothing to recover");
  process.exit(0);
}

const reserveAtoms = parseUnits(RESERVE, 6);
const amountAtoms = process.env.RECOVER_AMOUNT
  ? parseUnits(process.env.RECOVER_AMOUNT, 6)
  : balance - reserveAtoms;
if (amountAtoms <= 0n) {
  console.error(`✗ balance ${formatUnits(balance, 6)} too small to cover the relayer fee reserve (${RESERVE})`);
  process.exit(1);
}
const amountUsdc = formatUnits(amountAtoms, 6);

// If the account was never 7702-upgraded, bundle the upgrade authorization so
// recovery works even on a brand-new EOA that has never touched the demo.
const entry = await build7702AuthorizationEntry({
  publicClient,
  owner,
  chainId: chainConfig.chain.id,
  delegatorImpl: sa.environment.implementations.EIP7702StatelessDeleGatorImpl,
});

const dryRun = Boolean(process.env.RECOVER_DRY_RUN);
console.log(
  `\n${dryRun ? "DRY RUN — " : ""}sweeping ${amountUsdc} USDC -> ${TO} (gasless, fee in USDC, auth bundled: ${entry ? "yes" : "already upgraded"})`,
);
const claim = await claimBudgetViaRelayer({
  userSmartAccount: sa,
  recipient: TO,
  amountUsdc,
  memo: `brainbudget-recover-${FROM}`,
  authorizationList: entry ? [entry] : undefined,
  dryRun,
});
console.log(`task ${claim.taskId} | fee ${formatUnits(BigInt(claim.feeUsdcAtoms), 6)} USDC`);

if (dryRun) {
  console.log(
    `\nDRY RUN OK — the live 1Shot relayer accepted the signed recovery delegation from a` +
      ` zero-ETH account, simulated the USDC transfer, and priced the fee at` +
      ` ${formatUnits(BigInt(claim.feeUsdcAtoms), 6)} USDC. It WOULD execute the sweep. No funds moved.`,
  );
  process.exit(0);
}

const status = await waitForRelayerTask(claim.taskId);
const txHash = relayerTxHash(status);
console.log(`status ${status.status}${txHash ? ` | ${chainConfig.explorerTxUrl(txHash)}` : ""}`);
if (status.status !== 200) {
  console.error("✗ recovery task failed:", JSON.stringify(status).slice(0, 500));
  process.exit(1);
}

const [srcAfter, dstAfter] = await Promise.all([
  publicClient.readContract({ address: chainConfig.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] }),
  publicClient.readContract({ address: chainConfig.usdc, abi: erc20Abi, functionName: "balanceOf", args: [TO] }),
]);
console.log(`\nsource ${FROM} USDC after: ${formatUnits(srcAfter, 6)}`);
console.log(`dest        USDC after: ${formatUnits(dstAfter, 6)}`);
console.log("RECOVERY OK — funds left a zero-ETH account with no gas, no manual signing.");
