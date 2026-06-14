/**
 * ONE-TIME zero-ETH bootstrap of the .env accounts on the configured chain.
 *
 * The product /research flow upgrades the delegator EOAs with ensure7702Upgraded,
 * which needs a gas-funded submitter. On mainnet our accounts hold ZERO ETH, so
 * the upgrades have to ride the 1Shot relayer instead (gas paid in USDC). The
 * relayer accepts exactly ONE EIP-7702 authorization per task, so this is a chain
 * of tasks: each upgrades one account inside its type-4 tx and forwards a small
 * USDC seed so the NEXT account can pay its own relayer fee. The user (the only
 * funded account) bankrolls the chain.
 *
 *   user  → upgrades self, seeds agent
 *   agent → upgrades self, seeds critic
 *   critic→ upgrades self, returns the dust to the user
 *
 * After this runs once, ensure7702Upgraded() in the live flow is a no-op and the
 * full demo works with no ETH anywhere. Idempotent: exits early if everything is
 * already upgraded. Read RECOVER via scripts/recover.ts to sweep the seed dust.
 *
 *   pnpm exec tsx scripts/bootstrap-mainnet.ts            # real
 *   BOOTSTRAP_DRY_RUN=1 pnpm exec tsx scripts/bootstrap-mainnet.ts   # price the first hop, move nothing
 */
import "../src/env.js";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import type { Account } from "viem";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { build7702AuthorizationEntry } from "@brainbudget/shared";
import { chainConfig, getActors, publicClient } from "../src/config.js";
import { claimBudgetViaRelayer, relayerTxHash, waitForRelayerTask } from "../src/relayer.js";

const DRY_RUN = process.env.BOOTSTRAP_DRY_RUN === "1";
const SEED_AGENT = process.env.SEED_AGENT ?? "0.10"; // user → agent
const SEED_CRITIC = process.env.SEED_CRITIC ?? "0.04"; // agent → critic
const SEED_TAIL = process.env.SEED_TAIL ?? "0.01"; // critic → user (valid non-zero work transfer)

const actors = await getActors();
const delegatorImpl =
  actors.userSmartAccount.environment.implementations.EIP7702StatelessDeleGatorImpl;
const expectedCode = `0xef0100${delegatorImpl.slice(2).toLowerCase()}`;

const usdc = (address: `0x${string}`) =>
  publicClient.readContract({
    address: chainConfig.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

const isUpgraded = async (address: `0x${string}`) =>
  (await publicClient.getCode({ address }))?.toLowerCase() === expectedCode;

/** Poll until `address` holds at least `minUsdc`, so a forwarded seed has propagated. */
async function waitForUsdc(address: `0x${string}`, minUsdc: string): Promise<bigint> {
  const min = parseUnits(minUsdc, 6);
  let bal = 0n;
  for (let i = 0; i < 20 && bal < min; i++) {
    bal = await usdc(address);
    if (bal < min) await new Promise((r) => setTimeout(r, 2500));
  }
  if (bal < min) throw new Error(`${address} only holds ${formatUnits(bal, 6)} USDC, need ${minUsdc}`);
  return bal;
}

interface Hop {
  name: string;
  owner: Account;
  sa: MetaMaskSmartAccount;
  recipient: `0x${string}`;
  seed: string;
  /** USDC this account must already hold before its task can pay the relayer fee */
  needsFunded?: string;
}

const hops: Hop[] = [
  { name: "user", owner: actors.userEoa, sa: actors.userSmartAccount, recipient: actors.agentEoa.address, seed: SEED_AGENT },
  { name: "agent", owner: actors.agentEoa, sa: actors.agentSmartAccount, recipient: actors.criticEoa?.address ?? actors.userEoa.address, seed: SEED_CRITIC, needsFunded: SEED_CRITIC },
];
if (actors.criticSmartAccount && actors.criticEoa) {
  hops.push({ name: "critic", owner: actors.criticEoa, sa: actors.criticSmartAccount, recipient: actors.userEoa.address, seed: SEED_TAIL, needsFunded: SEED_TAIL });
}

console.log(`chain: ${chainConfig.chain.name} (${chainConfig.chain.id})  relayer: ${chainConfig.oneShotRelayerUrl}`);
for (const h of hops) console.log(`  ${h.name.padEnd(7)} ${h.owner.address}`);

// Idempotency: if every account already runs the delegator impl, there is nothing to do.
const states = await Promise.all(hops.map((h) => isUpgraded(h.owner.address)));
console.log(`\nupgrade state: ${hops.map((h, i) => `${h.name}=${states[i]}`).join("  ")}`);
if (states.every(Boolean)) {
  console.log("\nall .env accounts already 7702-upgraded — nothing to bootstrap.");
  process.exit(0);
}

const userUsdc = await usdc(actors.userEoa.address);
console.log(`\nuser USDC: ${formatUnits(userUsdc, 6)}`);
if (userUsdc < parseUnits(SEED_AGENT, 6)) {
  console.error(`✗ user needs at least ${SEED_AGENT} USDC to bankroll the bootstrap chain`);
  process.exit(1);
}

for (const hop of hops) {
  // Each non-first hop must already hold the seed forwarded by the previous hop.
  if (hop.needsFunded) {
    process.stdout.write(`[${hop.name}] waiting for seed (≥${hop.needsFunded} USDC)… `);
    const bal = await waitForUsdc(hop.owner.address, hop.needsFunded);
    console.log(`have ${formatUnits(bal, 6)}`);
  }

  const entry = await build7702AuthorizationEntry({
    publicClient,
    owner: hop.owner,
    chainId: chainConfig.chain.id,
    delegatorImpl,
  });

  const claim = await claimBudgetViaRelayer({
    userSmartAccount: hop.sa,
    recipient: hop.recipient,
    amountUsdc: hop.seed,
    memo: `brainbudget-bootstrap-${hop.name}`,
    authorizationList: entry ? [entry] : undefined,
    dryRun: DRY_RUN,
  });
  console.log(
    `[${hop.name}] task ${claim.taskId.slice(0, 16)}… | fee ${formatUnits(BigInt(claim.feeUsdcAtoms), 6)} USDC | auth: ${entry ? "bundled" : "already upgraded"} | seed ${hop.seed} → ${hop.recipient}`,
  );

  if (DRY_RUN) {
    console.log(`\nDRY RUN OK — the live relayer accepted the '${hop.name}' hop and priced it. No funds moved. Stopping after the first hop.`);
    process.exit(0);
  }

  const status = await waitForRelayerTask(claim.taskId);
  const txHash = relayerTxHash(status);
  console.log(`[${hop.name}] status ${status.status}${txHash ? ` | ${chainConfig.explorerTxUrl(txHash)}` : ""}`);
  if (status.status !== 200) {
    console.error(`✗ ${hop.name} bootstrap task failed:`, JSON.stringify(status).slice(0, 500));
    process.exit(1);
  }
}

// Confirm every account now runs the delegator implementation.
console.log("");
let upgraded = 0;
for (const hop of hops) {
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    ok = await isUpgraded(hop.owner.address);
    if (!ok) await new Promise((r) => setTimeout(r, 2500));
  }
  upgraded += ok ? 1 : 0;
  console.log(`${hop.name.padEnd(7)} 7702-upgraded: ${ok}`);
}

if (upgraded === hops.length) {
  console.log(`\nBOOTSTRAP COMPLETE — ${upgraded} .env accounts upgraded gaslessly via 1Shot. ensure7702Upgraded() is now a no-op; the live demo runs with zero ETH.`);
} else {
  console.error("✗ bootstrap incomplete — re-run to retry the missing hops");
  process.exit(1);
}
