/**
 * Full gasless onboarding e2e: THREE fresh burner EOAs (user, agent, critic)
 * holding ZERO ETH. The relayer accepts exactly ONE EIP-7702 authorization
 * per task, so bootstrap is a chain of three gasless tasks — each upgrades
 * one account inside the type-4 tx and forwards USDC to fund the next
 * account's relayer fee. This is what makes "no ETH anywhere" true on
 * mainnet.
 */
import "../src/env.js";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { build7702AuthorizationEntry, makeSmartAccount7702 } from "@brainbudget/shared";
import { chainConfig, getActors, publicClient } from "../src/config.js";
import { claimBudgetViaRelayer, relayerTxHash, waitForRelayerTask } from "../src/relayer.js";

const SEED_USDC = "0.1";
const CLAIM_USDC = "0.02";

// 1. three fresh burners — no ETH, ever
const [freshUser, freshAgent, freshCritic] = [0, 1, 2].map(() =>
  privateKeyToAccount(generatePrivateKey()),
);
console.log(`fresh user:   ${freshUser.address}`);
console.log(`fresh agent:  ${freshAgent.address}`);
console.log(`fresh critic: ${freshCritic.address}`);

// 2. seed the fresh user with USDC — itself a gasless relayer claim from the
// env user's account (no wallet in this script ever touches ETH)
const { userSmartAccount: envUserSA } = await getActors();
const seed = await claimBudgetViaRelayer({
  userSmartAccount: envUserSA,
  recipient: freshUser.address,
  amountUsdc: SEED_USDC,
  memo: "brainbudget-7702-bootstrap-seed",
});
const seedStatus = await waitForRelayerTask(seed.taskId);
if (seedStatus.status !== 200) {
  console.error("✗ seed claim failed:", JSON.stringify(seedStatus).slice(0, 400));
  process.exit(1);
}
console.log(`\nseeded ${SEED_USDC} USDC -> fresh user (gasless via 1Shot, task ${seed.taskId.slice(0, 14)}…)`);

// 3. bootstrap chain: each task upgrades ONE account (relayer limit) and
// forwards USDC so the next account can pay its own relayer fee
const userSA = await makeSmartAccount7702(publicClient, freshUser);
const agentSA = await makeSmartAccount7702(publicClient, freshAgent);
const criticSA = await makeSmartAccount7702(publicClient, freshCritic);
const delegatorImpl = userSA.environment.implementations.EIP7702StatelessDeleGatorImpl;

const hops = [
  { name: "user", owner: freshUser, sa: userSA, recipient: freshAgent.address, amount: "0.05" },
  { name: "agent", owner: freshAgent, sa: agentSA, recipient: freshCritic.address, amount: CLAIM_USDC },
  { name: "critic", owner: freshCritic, sa: criticSA, recipient: freshUser.address, amount: "0.005" },
] as const;

for (const hop of hops) {
  const entry = await build7702AuthorizationEntry({
    publicClient,
    owner: hop.owner,
    chainId: chainConfig.chain.id,
    delegatorImpl,
  });
  const claim = await claimBudgetViaRelayer({
    userSmartAccount: hop.sa,
    recipient: hop.recipient,
    amountUsdc: hop.amount,
    memo: `brainbudget-7702-bootstrap-${hop.name}`,
    authorizationList: entry ? [entry] : undefined,
  });
  console.log(
    `[${hop.name}] task ${claim.taskId.slice(0, 14)}… | fee ${formatUnits(BigInt(claim.feeUsdcAtoms), 6)} USDC | auth: ${entry ? "yes" : "already upgraded"}`,
  );
  const status = await waitForRelayerTask(claim.taskId);
  const txHash = relayerTxHash(status);
  console.log(`[${hop.name}] status ${status.status}${txHash ? ` | ${chainConfig.explorerTxUrl(txHash)}` : ""}`);
  if (status.status !== 200) {
    console.error(`✗ ${hop.name} bootstrap task failed:`, JSON.stringify(status).slice(0, 500));
    process.exit(1);
  }
}

// 5. verify: all three EOAs now run the delegator implementation, claim landed
const expectedCode = `0xef0100${delegatorImpl.slice(2).toLowerCase()}`;
let upgraded = 0;
for (const [name, owner] of [
  ["user", freshUser],
  ["agent", freshAgent],
  ["critic", freshCritic],
] as const) {
  let code: string | undefined;
  for (let i = 0; i < 10 && code?.toLowerCase() !== expectedCode; i++) {
    code = await publicClient.getCode({ address: owner.address });
    if (code?.toLowerCase() !== expectedCode) await new Promise((r) => setTimeout(r, 2000));
  }
  const ok = code?.toLowerCase() === expectedCode;
  upgraded += ok ? 1 : 0;
  console.log(`${name} 7702-upgraded: ${ok}`);
}

let agentUsdc = 0n;
for (let i = 0; i < 10 && agentUsdc === 0n; i++) {
  agentUsdc = await publicClient.readContract({
    address: chainConfig.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [freshAgent.address],
  });
  if (agentUsdc === 0n) await new Promise((r) => setTimeout(r, 2000));
}
console.log(`fresh agent USDC: ${formatUnits(agentUsdc, 6)}`);

if (upgraded === 3 && agentUsdc === parseUnits(CLAIM_USDC, 6)) {
  console.log(
    "\n7702 BOOTSTRAP E2E PASSED — three zero-ETH accounts upgraded via three chained gasless 1Shot tasks, fees paid in USDC.",
  );
} else {
  console.error("✗ bootstrap incomplete");
  process.exit(1);
}
