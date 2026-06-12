import { randomBytes, createPublicKey, verify as edVerify } from "node:crypto";
import {
  ScopeType,
  createDelegation,
  type MetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { bytesToHex } from "viem/utils";
import { chainConfig } from "./config.js";

const RELAYER_URL = chainConfig.oneShotRelayerUrl;
const JWKS_URL = new URL("/.well-known/jwks.json", RELAYER_URL).toString();

let rpcId = 0;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(RELAYER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method} failed: [${body.error.code}] ${body.error.message}`);
  return body.result as T;
}

/** bigint/Uint8Array -> hex, recursively (relayer JSON-RPC wants plain JSON). */
function toRelayerJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(toRelayerJson);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toRelayerJson(v);
    }
    return out;
  }
  return value;
}

interface ChainCapabilities {
  feeCollector: `0x${string}`;
  targetAddress: `0x${string}`;
  tokens: { address: `0x${string}`; symbol?: string; decimals: number | string }[];
}

let capabilitiesCache: ChainCapabilities | undefined;

export async function getCapabilities(): Promise<ChainCapabilities> {
  if (capabilitiesCache) return capabilitiesCache;
  const chainId = String(chainConfig.chain.id);
  const caps = await rpc<Record<string, ChainCapabilities>>("relayer_getCapabilities", [chainId]);
  const chainCaps = caps[chainId];
  if (!chainCaps) throw new Error(`1Shot relayer does not support chain ${chainId}`);
  capabilitiesCache = chainCaps;
  return chainCaps;
}

interface Estimate7710Result {
  success: boolean;
  error?: string;
  requiredPaymentAmount?: string;
  gasUsed?: Record<string, string>;
  context?: string;
}

export interface ClaimResult {
  taskId: string;
  feeUsdcAtoms: string;
  targetAddress: `0x${string}`;
}

/**
 * The agent claims a USDC tranche from the user's account, gaslessly:
 * one delegation user -> relayer targetAddress scoped to fee+amount, two
 * executions (fee transfer to feeCollector, work transfer to the agent).
 * Estimate-first with price lock; webhook updates if webhookUrl is public.
 */
export async function claimBudgetViaRelayer(opts: {
  userSmartAccount: MetaMaskSmartAccount;
  recipient: `0x${string}`;
  amountUsdc: string;
  webhookUrl?: string;
  memo?: string;
  /** EIP-7702 authorizations to bundle into the relayer's type-4 tx (gasless upgrades) */
  authorizationList?: unknown[];
}): Promise<ClaimResult> {
  const caps = await getCapabilities();
  const usdc = caps.tokens.find((t) => t.symbol === "USDC");
  if (!usdc) throw new Error("relayer does not accept USDC on this chain");

  const workAmount = parseUnits(opts.amountUsdc, 6);

  const buildAndSign = async (feeAmount: bigint) => {
    const delegation = createDelegation({
      to: caps.targetAddress,
      from: opts.userSmartAccount.address,
      environment: opts.userSmartAccount.environment,
      salt: bytesToHex(Uint8Array.from(randomBytes(32))) as `0x${string}`,
      scope: {
        type: ScopeType.Erc20TransferAmount,
        tokenAddress: usdc.address,
        maxAmount: feeAmount + workAmount,
      },
    });
    const signature = await opts.userSmartAccount.signDelegation({ delegation });
    const signedDelegation = { ...delegation, signature };
    const executions = [
      {
        target: usdc.address,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [caps.feeCollector, feeAmount],
        }),
      },
      {
        target: usdc.address,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [opts.recipient, workAmount],
        }),
      },
    ];
    return {
      chainId: String(chainConfig.chain.id),
      ...(opts.authorizationList?.length ? { authorizationList: opts.authorizationList } : {}),
      transactions: [
        { permissionContext: [toRelayerJson(signedDelegation)], executions },
      ],
    };
  };

  // estimate with a mock fee at the $0.01 floor
  let feeAmount = parseUnits("0.01", 6);
  let params = await buildAndSign(feeAmount);
  const estimate = await rpc<Estimate7710Result>("relayer_estimate7710Transaction", params);
  if (!estimate.success) throw new Error(`relayer estimate failed: ${estimate.error}`);

  const required = BigInt(estimate.requiredPaymentAmount ?? feeAmount);
  if (required !== feeAmount) {
    feeAmount = required;
    params = await buildAndSign(feeAmount);
  }

  const taskId = await rpc<string>("relayer_send7710Transaction", {
    ...params,
    context: estimate.context,
    ...(opts.webhookUrl ? { destinationUrl: opts.webhookUrl } : {}),
    ...(opts.memo ? { memo: opts.memo } : {}),
  });

  return {
    taskId,
    feeUsdcAtoms: feeAmount.toString(),
    targetAddress: caps.targetAddress,
  };
}

export interface RelayerStatus {
  status: number;
  hash?: string;
  receipt?: { transactionHash?: string; [key: string]: unknown };
  message?: string;
  memo?: string;
  [key: string]: unknown;
}

/** tx hash regardless of task state: `hash` while pending, `receipt.transactionHash` once confirmed */
export function relayerTxHash(status: RelayerStatus): string | undefined {
  return status.hash ?? status.receipt?.transactionHash;
}

export async function getRelayerStatus(taskId: string): Promise<RelayerStatus> {
  return rpc<RelayerStatus>("relayer_getStatus", { id: taskId, logs: false });
}

export async function waitForRelayerTask(
  taskId: string,
  timeoutMs = 120_000,
): Promise<RelayerStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getRelayerStatus(taskId);
    if ([200, 400, 500].includes(status.status)) return status;
    if (Date.now() > deadline) throw new Error(`relayer task ${taskId} timed out (last status ${status.status})`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

/* ---------- webhook verification (Ed25519 over stable-sorted JSON) ---------- */

type Jwk = { kid?: string; kty: string; crv?: string; x?: string };
let jwksCache: Jwk[] | undefined;

async function getJwks(): Promise<Jwk[]> {
  if (!jwksCache) {
    const response = await fetch(JWKS_URL);
    const body = (await response.json()) as { keys: Jwk[] };
    jwksCache = body.keys;
  }
  return jwksCache;
}

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

export async function verifyRelayerWebhook(
  body: Record<string, unknown>,
  jwksOverride?: Jwk[],
): Promise<boolean> {
  const { signature, ...rest } = body;
  const keyId = (body as { keyId?: string }).keyId;
  if (typeof signature !== "string") return false;
  const keys = jwksOverride ?? (await getJwks());
  const jwk = (keyId ? keys.find((k) => k.kid === keyId) : keys[0]) ?? keys[0];
  if (!jwk?.x) return false;
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  const payload = Buffer.from(stableStringify(rest), "utf8");
  return edVerify(null, payload, publicKey, Buffer.from(signature, "base64"));
}
