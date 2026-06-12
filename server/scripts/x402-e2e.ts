/**
 * Day 1 e2e: agent pays the x402-paywalled gateway with the USER's delegated
 * authority via an erc7710 redelegation chain, settled by the MetaMask facilitator.
 *
 *  1. user + agent smart accounts (both deployed)
 *  2. user -> agent-smart-account budget delegation (1 USDC, 10 calls, 24h)
 *  3. gateway starts in-process with VENICE_MOCK unless mainnet
 *  4. plain fetch -> expect 402; paid fetch -> expect 200 + PAYMENT-RESPONSE
 */
import "../src/env.js";
process.env.VENICE_MOCK ??= process.env.CHAIN === "base" ? "0" : "1";

import express from "express";
import {
  createBudgetDelegation,
  ensure7702Upgraded,
} from "@brainbudget/shared";
import { chainConfig, getActors, publicClient, SERVER_PORT } from "../src/config.js";
import { makeGateway } from "../src/gateway.js";
import { makePaidFetch } from "../src/buyer.js";

const actors = await getActors();
const { userEoa, agentEoa, userSmartAccount, agentSmartAccount, agentWallet, gatewayEoa } = actors;

console.log(`chain: ${chainConfig.chain.name} | user SA: ${userSmartAccount.address} | agent SA: ${agentSmartAccount.address}`);

// 1. both EOAs must be 7702-upgraded to EIP7702StatelessDeleGator
//    (the facilitator requires this of erc7710 delegators)
const delegatorImpl =
  userSmartAccount.environment.implementations.EIP7702StatelessDeleGatorImpl;
for (const [name, owner] of [["user", userEoa], ["agent", agentEoa]] as const) {
  const result = await ensure7702Upgraded({
    publicClient,
    owner,
    submitter: agentWallet,
    chain: chainConfig.chain,
    delegatorImpl,
  });
  console.log(`${name} EOA 7702 upgrade: ${result}`);
}

// 2. budget delegation to the AGENT SMART ACCOUNT (x402 redelegation flow)
const userDelegation = await createBudgetDelegation({
  to: agentSmartAccount.address,
  delegator: userSmartAccount,
  usdc: chainConfig.usdc,
  maxUsdc: "1",
  maxCalls: 10,
  validForSeconds: 24 * 3600,
});
console.log("budget delegation signed: 1 USDC / 10 calls / 24h -> agent smart account");

// 3. gateway in-process
const app = express();
app.use(makeGateway(gatewayEoa.address));
const port = SERVER_PORT + 1;
const server = app.listen(port);
const url = `http://localhost:${port}/paid/inference`;
const body = JSON.stringify({ messages: [{ role: "user", content: "Say hi in five words." }] });
const headers = { "Content-Type": "application/json" };

// 4a. unpaid request must 402
const unpaid = await fetch(url, { method: "POST", headers, body });
console.log(`\nunpaid request -> HTTP ${unpaid.status} ${unpaid.status === 402 ? "✓ (payment required)" : "✗ EXPECTED 402"}`);
if (unpaid.status !== 402) process.exit(1);

// 4b. paid request must 200 with settlement
const paidFetch = makePaidFetch({
  agentSmartAccount,
  delegationChain: [userDelegation],
  onPayment: (event) => console.log(`payment settled: ${event.paymentResponse?.slice(0, 80)}...`),
});
const paid = await paidFetch(url, { method: "POST", headers, body });
const payload = await paid.json();
console.log(`paid request   -> HTTP ${paid.status}`);
console.log(`response: ${JSON.stringify(payload).slice(0, 200)}`);

server.close();
if (paid.status !== 200) {
  console.error("✗ paid request failed");
  process.exit(1);
}
console.log("\nX402 E2E PASSED — agent paid with the user's delegated authority.");
