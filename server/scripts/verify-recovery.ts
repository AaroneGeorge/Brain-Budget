/**
 * Pre-funding safety check. Proves, before any mainnet USDC moves:
 *   1. The keys in .env DERIVE to exactly the addresses you'd fund (gateway, user).
 *   2. What each address holds today on BOTH chains (ETH, USDC) and whether it's
 *      already 7702-upgraded (code present).
 * No funds move. Read-only.
 */
import "../src/env.js";
import { createPublicClient, http, erc20Abi, formatEther, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, getRpcUrl } from "@brainbudget/shared";

const KEYS: [string, string][] = [
  ["user", process.env.USER_PRIVATE_KEY ?? ""],
  ["agent", process.env.AGENT_PRIVATE_KEY ?? ""],
  ["gateway", process.env.GATEWAY_PRIVATE_KEY ?? ""],
  ["critic", process.env.CRITIC_PRIVATE_KEY ?? ""],
];

console.log("=== key -> address derivation (does .env control the funded addresses?) ===");
const accounts = KEYS.filter(([, k]) => k).map(([name, k]) => {
  const acct = privateKeyToAccount(k as `0x${string}`);
  console.log(`${name.padEnd(8)} ${acct.address}`);
  return { name, address: acct.address };
});

for (const [chainKey, config] of Object.entries(CHAINS)) {
  const client = createPublicClient({ chain: config.chain, transport: http(getRpcUrl(config)) });
  console.log(`\n=== ${chainKey} (${config.chain.id}) — USDC ${config.usdc} ===`);
  for (const { name, address } of accounts) {
    const [eth, usdc, code] = await Promise.all([
      client.getBalance({ address: address as `0x${string}` }),
      client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }),
      client.getCode({ address: address as `0x${string}` }),
    ]);
    const upgraded = code && code !== "0x" ? `7702:${code.slice(0, 12)}…` : "plain EOA";
    console.log(
      `${name.padEnd(8)} ETH ${formatEther(eth).slice(0, 12).padEnd(12)} USDC ${formatUnits(usdc, 6).padEnd(12)} ${upgraded}`,
    );
  }
}
