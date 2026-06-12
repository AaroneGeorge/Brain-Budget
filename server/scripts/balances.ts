import "../src/env.js";
import { erc20Abi, formatEther, formatUnits } from "viem";
import { chainConfig, publicClient } from "../src/config.js";

const addrs: [string, `0x${string}`][] = [
  ["user", "0xCfcFaF3787850C989035f348F9FAdf8c2A3deaD2"],
  ["agent", "0x2899334B59624dc554994375329D16004E1a964D"],
  ["gateway", "0x1f550242630340E021EeF4237110a51c933C1c5D"],
  ["critic", "0x99df9265a194A607bBd2d51Edc18e73D5Bb82547"],
];
for (const [name, address] of addrs) {
  const [eth, usdc] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: chainConfig.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  console.log(
    `${name.padEnd(8)} ETH ${formatEther(eth).slice(0, 10).padEnd(10)} USDC ${formatUnits(usdc, 6)}`,
  );
}
