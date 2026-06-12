/**
 * Webhook verification test: signs a synthetic 1Shot-shaped webhook with a
 * locally generated Ed25519 key (injected as the JWKS) and asserts that
 * verifyRelayerWebhook accepts the genuine envelope and rejects a tampered one.
 */
import "../src/env.js";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyRelayerWebhook } from "../src/relayer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
const jwks = [{ kid: "test-key-1", kty: jwk.kty, crv: jwk.crv, x: jwk.x }];

// same canonical form the relayer signs: sorted-key JSON of the body minus signature
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const envelope = {
  apiVersion: 0,
  type: 0,
  data: {
    id: "0xe41b0bf3b9645d8b6cc4192c0445d68300ba89ab64cb8a15ae5a64a9624ab3dd",
    status: 200,
    memo: "run-1-test",
    receipt: { transactionHash: "0xfc8faed4250ee77cfcde8104b38bed093f5ad16ebe8d784940c8baf4e607e6fd" },
  },
  timestamp: 1781295777,
  keyId: "test-key-1",
};

const signature = edSign(null, Buffer.from(stableStringify(envelope), "utf8"), privateKey).toString(
  "base64",
);

const genuine = { ...envelope, signature };
const tampered = { ...envelope, data: { ...envelope.data, memo: "run-666-evil" }, signature };
const unsigned = { ...envelope };

const results = await Promise.all([
  verifyRelayerWebhook(genuine, jwks),
  verifyRelayerWebhook(tampered, jwks),
  verifyRelayerWebhook(unsigned as Record<string, unknown>, jwks),
]);

console.log(`genuine envelope verified: ${results[0]}`);
console.log(`tampered envelope rejected: ${!results[1]}`);
console.log(`missing signature rejected: ${!results[2]}`);

if (results[0] && !results[1] && !results[2]) {
  console.log("\nWEBHOOK VERIFY TEST PASSED — Ed25519 over stable-sorted JSON");
} else {
  console.error("\n✗ webhook verification logic broken");
  process.exit(1);
}
