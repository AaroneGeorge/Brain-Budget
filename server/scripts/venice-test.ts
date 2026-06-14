/**
 * Isolated real-Venice test through the SAME code path the server uses
 * (src/venice.ts runInference). First call auto-tops-up $5 from the gateway
 * wallet (zero ETH, x402 EIP-3009). Proves real inference before the full e2e.
 */
import "../src/env.js";
import { runInference, veniceBalance, veniceMocked } from "../src/venice.js";

console.log(`veniceMocked: ${veniceMocked()}`);
console.log("balance before:", JSON.stringify(await veniceBalance()));

const result = await runInference({
  messages: [
    { role: "system", content: "Answer in one concise sentence." },
    { role: "user", content: "What is EIP-7702 and why does it matter for account abstraction?" },
  ],
  max_tokens: 120,
});

console.log(`\nmodel: ${result.model}  mocked: ${result.mocked}`);
console.log(`tokens: ${JSON.stringify(result.usage)}`);
console.log(`content: ${result.content}`);
console.log("\nbalance after:", JSON.stringify(await veniceBalance()));
