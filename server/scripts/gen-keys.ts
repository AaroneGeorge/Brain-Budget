import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Prints three fresh burner keypairs for .env (USER, AGENT, GATEWAY).
// Never reuse real wallets; fund only what the demo needs.
for (const role of ["USER", "AGENT", "GATEWAY"] as const) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  console.log(`${role}_PRIVATE_KEY=${key}`);
  console.log(`# ${role} EOA address: ${account.address}`);
}
