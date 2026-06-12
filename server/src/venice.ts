import "./env.js";
import { VeniceClient } from "venice-x402-client";

export interface InferenceRequest {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface InferenceResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  veniceBalanceUsd?: number;
  mocked: boolean;
}

const MODEL = process.env.VENICE_MODEL ?? "llama-3.3-70b";

let veniceClient: VeniceClient | undefined;

function getVenice(): VeniceClient {
  veniceClient ??= new VeniceClient(process.env.GATEWAY_PRIVATE_KEY!, {
    autoTopUp: { enabled: true, amount: 5 },
  });
  return veniceClient;
}

/** Venice payments live on Base mainnet; VENICE_MOCK=1 lets the x402 paywall be tested without them. */
export function veniceMocked(): boolean {
  return process.env.VENICE_MOCK === "1";
}

export async function runInference(request: InferenceRequest): Promise<InferenceResult> {
  if (veniceMocked()) {
    return {
      content:
        "[MOCK INFERENCE] Venice is disabled (VENICE_MOCK=1). The x402 payment for this request was real; the tokens are not.",
      model: "mock",
      mocked: true,
    };
  }
  const venice = getVenice();
  const response = await venice.chat({
    model: request.model ?? MODEL,
    messages: request.messages,
    max_tokens: request.max_tokens ?? 800,
    temperature: request.temperature ?? 0.3,
  });
  return {
    content: response.choices[0]?.message.content ?? "",
    model: request.model ?? MODEL,
    usage: response.usage,
    veniceBalanceUsd: venice.balance,
    mocked: false,
  };
}

export async function veniceBalance(): Promise<{
  balanceUsd: number;
  minimumTopUpUsd: number;
  suggestedTopUpUsd: number;
} | null> {
  if (veniceMocked()) return null;
  const { balanceUsd, minimumTopUpUsd, suggestedTopUpUsd } = await getVenice().getBalance();
  return { balanceUsd, minimumTopUpUsd, suggestedTopUpUsd };
}

export async function veniceTopUp(amountUsd: number): Promise<void> {
  await getVenice().topUp(amountUsd);
}
