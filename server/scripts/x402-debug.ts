/** Probe: inspect the 402 requirements, then step the buyer manually to find the failure. */
import "../src/env.js";
process.env.VENICE_MOCK ??= "1";

import express from "express";
import { createBudgetDelegation, ensureDeployed } from "@brainbudget/shared";
import { createx402DelegationProvider } from "@metamask/smart-accounts-kit/experimental";
import { encodeDelegations } from "@metamask/smart-accounts-kit/utils";
import { x402Erc7710Client } from "@metamask/x402";
import { chainConfig, getActors, publicClient, SERVER_PORT, facilitatorUrl } from "../src/config.js";
import { makeGateway } from "../src/gateway.js";

const { userSmartAccount, agentSmartAccount, agentWallet, gatewayEoa } = await getActors();
console.log(`facilitator: ${facilitatorUrl}`);

await ensureDeployed(publicClient, agentSmartAccount, agentWallet, chainConfig.chain);

const userDelegation = await createBudgetDelegation({
  to: agentSmartAccount.address,
  delegator: userSmartAccount,
  usdc: chainConfig.usdc,
  maxUsdc: "1",
  maxCalls: 10,
  validForSeconds: 24 * 3600,
});

const app = express();
app.use(makeGateway(gatewayEoa.address));
const port = SERVER_PORT + 2;
const server = app.listen(port);

// 1. inspect the 402
const unpaid = await fetch(`http://localhost:${port}/paid/inference`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
});
console.log(`\nunpaid status: ${unpaid.status}`);
console.log(`PAYMENT-REQUIRED header: ${unpaid.headers.get("PAYMENT-REQUIRED")}`);
const requiredBody = await unpaid.text();
console.log(`402 body: ${requiredBody}\n`);

// 2. extract requirements (header is base64 JSON in v2; body JSON in some versions)
let paymentRequired: any;
const header = unpaid.headers.get("PAYMENT-REQUIRED");
if (header) {
  paymentRequired = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
} else {
  paymentRequired = JSON.parse(requiredBody);
}
console.log("decoded requirements:", JSON.stringify(paymentRequired, null, 2));

// 3. step the provider manually
const accepts = paymentRequired.accepts?.[0];
const provider = createx402DelegationProvider({
  account: agentSmartAccount,
  parentPermissionContext: encodeDelegations([userDelegation]),
});
try {
  const payload = await provider(accepts);
  console.log("\nprovider OK:", JSON.stringify(payload).slice(0, 300));
} catch (error) {
  console.error("\nprovider THREW:", (error as Error).message);
}

// 4. step the scheme client manually, then hit the facilitator /verify directly
try {
  const client = new x402Erc7710Client({
    delegationProvider: provider,
  });
  const paymentPayload = await client.createPaymentPayload(
    paymentRequired.x402Version ?? 2,
    accepts,
  );
  console.log("\ncreatePaymentPayload OK (keys):", Object.keys(paymentPayload.payload));

  const verifyBody = {
    x402Version: paymentRequired.x402Version ?? 2,
    paymentPayload: {
      x402Version: paymentRequired.x402Version ?? 2,
      scheme: "exact",
      network: accepts.network,
      payload: paymentPayload.payload,
      ...(paymentPayload.extensions ? { extensions: paymentPayload.extensions } : {}),
    },
    paymentRequirements: accepts,
  };
  const verifyResponse = await fetch(`${facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verifyBody),
  });
  console.log(`\nfacilitator /verify -> HTTP ${verifyResponse.status}`);
  console.log(await verifyResponse.text());
} catch (error) {
  console.error("\ncreatePaymentPayload/verify THREW:", (error as Error).message);
}

server.close();
