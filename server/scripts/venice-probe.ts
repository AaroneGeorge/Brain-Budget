/**
 * Read-only Venice + gateway probe. Prints the gateway's exact on-chain USDC and
 * the Venice account's credit balance + minimum/suggested top-up — WITHOUT
 * auto-topping-up — so we can pick a safe top-up amount before spending.
 */
import "../src/env.js";
import { erc20Abi, formatUnits } from "viem";
import { VeniceClient } from "venice-x402-client";
import { chainConfig, publicClient } from "../src/config.js";
import { accountFromEnv } from "@brainbudget/shared";

const gateway = accountFromEnv("GATEWAY_PRIVATE_KEY");
const onchain = await publicClient.readContract({
  address: chainConfig.usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [gateway.address],
});
console.log(`gateway ${gateway.address}`);
console.log(`gateway on-chain USDC: ${formatUnits(onchain, 6)} (chain ${chainConfig.chain.id})`);

const client = new VeniceClient(process.env.GATEWAY_PRIVATE_KEY!, {
  autoTopUp: { enabled: false, amount: 0 }, // read-only probe — never top up
});
try {
  const bal = await client.getBalance();
  console.log("venice getBalance():", JSON.stringify(bal, null, 2));
} catch (error) {
  console.error("venice getBalance() failed:", (error as Error).message);
}
