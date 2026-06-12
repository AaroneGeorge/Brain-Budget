import "../src/env.js";
import {
  accountFromEnv,
  getChainConfig,
  makePublicClient,
  makeSmartAccount,
} from "@brainbudget/shared";

// Prints every address that needs funding, including counterfactual smart accounts.
const config = getChainConfig(process.env.CHAIN);
const publicClient = makePublicClient(config);

const user = accountFromEnv("USER_PRIVATE_KEY");
const agent = accountFromEnv("AGENT_PRIVATE_KEY");
const gateway = accountFromEnv("GATEWAY_PRIVATE_KEY");

const userSmartAccount = await makeSmartAccount(publicClient, user);
const agentSmartAccount = await makeSmartAccount(publicClient, agent);

console.log(`chain: ${config.chain.name} (${config.chain.id})`);
console.log(`USER EOA:            ${user.address}`);
console.log(`USER smart account:  ${userSmartAccount.address}   <- fund with USDC (the delegated budget lives here)`);
console.log(`AGENT EOA:           ${agent.address}   <- fund with a little ETH for gas (dev only)`);
console.log(`AGENT smart account: ${agentSmartAccount.address}`);
console.log(`GATEWAY EOA:         ${gateway.address}   <- (mainnet later) USDC for the Venice x402 top-up`);
