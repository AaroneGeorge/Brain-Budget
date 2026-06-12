import { base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";

export type SupportedChainKey = "base" | "baseSepolia";

export interface ChainConfig {
  chain: Chain;
  rpcUrlEnv: string;
  defaultRpcUrl: string;
  usdc: `0x${string}`;
  /** MetaMask tx-sentinel x402 facilitator (erc7710-capable). Docs show two hostnames; primary first. */
  facilitatorUrls: string[];
  oneShotRelayerUrl: string;
  explorerTxUrl: (hash: string) => string;
}

export const CHAINS: Record<SupportedChainKey, ChainConfig> = {
  base: {
    chain: base,
    rpcUrlEnv: "BASE_RPC_URL",
    defaultRpcUrl: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    facilitatorUrls: [
      "https://tx-sentinel-base-mainnet.dev-api.cx.metamask.io/platform/v2/x402",
      "https://tx-sentinel-base-mainnet.api.cx.metamask.io/platform/v2/x402",
    ],
    oneShotRelayerUrl: "https://relayer.1shotapi.com/relayers",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  baseSepolia: {
    chain: baseSepolia,
    rpcUrlEnv: "BASE_SEPOLIA_RPC_URL",
    defaultRpcUrl: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    facilitatorUrls: [
      "https://tx-sentinel-base-sepolia.dev-api.cx.metamask.io/platform/v2/x402",
      "https://tx-sentinel-base-sepolia.api.cx.metamask.io/platform/v2/x402",
    ],
    oneShotRelayerUrl: "https://relayer.1shotapi.dev/relayers",
    explorerTxUrl: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
  },
};

export function getChainConfig(key: string | undefined): ChainConfig {
  const k = (key ?? "baseSepolia") as SupportedChainKey;
  const config = CHAINS[k];
  if (!config) {
    throw new Error(`Unsupported CHAIN "${key}" — use one of: ${Object.keys(CHAINS).join(", ")}`);
  }
  return config;
}

export function getRpcUrl(config: ChainConfig): string {
  return process.env[config.rpcUrlEnv] || config.defaultRpcUrl;
}
