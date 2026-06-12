import { EventEmitter } from "node:events";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { createSubDelegation, type SignedDelegation } from "@brainbudget/shared";
import { makePaidFetch, type PaymentEvent } from "../buyer.js";
import { INFERENCE_PRICE, chainConfig } from "../config.js";
import {
  claimBudgetViaRelayer,
  relayerTxHash,
  waitForRelayerTask,
  type RelayerStatus,
} from "../relayer.js";

export type AgentEvent =
  | { type: "status"; at: string; message: string }
  | { type: "plan"; at: string; queries: string[] }
  | {
      type: "payment";
      at: string;
      payment: PaymentEvent;
      spentUsd: number;
      budgetUsd: number;
      actor?: "orchestrator" | "critic";
    }
  | { type: "step"; at: string; query: string; answer: string }
  | { type: "budget-stop"; at: string; reason: string }
  | {
      type: "a2a";
      at: string;
      from: string;
      to: string;
      capUsd: number;
      maxCalls: number;
      authority: string;
      message: string;
    }
  | { type: "critique"; at: string; review: string }
  | { type: "result"; at: string; report: string; spentUsd: number; calls: number }
  | {
      type: "relayer";
      at: string;
      phase: "claiming" | "submitted" | "confirmed" | "failed" | "webhook";
      message: string;
      taskId?: string;
      feeUsd?: number;
      amountUsd?: number;
      txUrl?: string;
    }
  | { type: "error"; at: string; message: string };

export interface ResearchRun {
  id: string;
  question: string;
  events: AgentEvent[];
  emitter: EventEmitter;
  done: boolean;
}

const PRICE_USD = Number(INFERENCE_PRICE.replace("$", ""));

const now = () => new Date().toISOString();

let runCounter = 0;
export const runs = new Map<string, ResearchRun>();

export function startResearch(opts: {
  question: string;
  budgetUsd: number;
  inferenceUrl: string;
  agentSmartAccount: MetaMaskSmartAccount;
  userDelegation: SignedDelegation;
  /** when set, the agent invoices a completion fee from this account via 1Shot after the run */
  userSmartAccount?: MetaMaskSmartAccount;
  /** when set, the orchestrator redelegates a narrowed sub-budget to this critic (A2A) */
  criticSmartAccount?: MetaMaskSmartAccount;
}): ResearchRun {
  const run: ResearchRun = {
    id: `run-${++runCounter}-${Date.now().toString(36)}`,
    question: opts.question,
    events: [],
    emitter: new EventEmitter(),
    done: false,
  };
  runs.set(run.id, run);
  void (async () => {
    try {
      await executeRun(run, opts);
      await claimCompletionFee(run, opts);
    } catch (error) {
      emit(run, { type: "error", at: now(), message: (error as Error).message });
    } finally {
      run.done = true;
      run.emitter.emit("done");
    }
  })();
  return run;
}

function emit(run: ResearchRun, event: AgentEvent) {
  run.events.push(event);
  run.emitter.emit("event", event);
}

async function executeRun(
  run: ResearchRun,
  opts: Parameters<typeof startResearch>[0],
): Promise<void> {
  let spentUsd = 0;
  let calls = 0;

  const onPayment = (actor: "orchestrator" | "critic") => (payment: PaymentEvent) => {
    spentUsd += PRICE_USD;
    calls += 1;
    emit(run, { type: "payment", at: now(), payment, spentUsd, budgetUsd: opts.budgetUsd, actor });
  };

  const paidFetch = makePaidFetch({
    agentSmartAccount: opts.agentSmartAccount,
    delegationChain: [opts.userDelegation],
    onPayment: onPayment("orchestrator"),
  });

  const askVia =
    (fetcher: typeof fetch) =>
    async (messages: { role: "system" | "user" | "assistant"; content: string }[]) => {
      const response = await fetcher(opts.inferenceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (response.status === 402) {
        throw new BudgetExhausted("payment rejected by the caveat enforcer (budget or call limit reached)");
      }
      if (!response.ok) throw new Error(`inference failed: HTTP ${response.status}`);
      const payload = (await response.json()) as { content: string };
      return payload.content;
    };
  const ask = askVia(paidFetch);

  const hasBudgetFor = (upcomingCalls: number) =>
    spentUsd + upcomingCalls * PRICE_USD <= opts.budgetUsd + 1e-9;

  emit(run, { type: "status", at: now(), message: `Planning research for: ${run.question}` });

  // 1. plan (1 paid call)
  if (!hasBudgetFor(1)) {
    emit(run, { type: "budget-stop", at: now(), reason: "insufficient budget for planning" });
    return finish(run, "Budget too small to start.", spentUsd, calls);
  }
  const planRaw = await ask([
    {
      role: "system",
      content:
        "You are a research planner. Output ONLY a JSON array of 2-3 short, distinct research sub-questions for the user's question. No prose.",
    },
    { role: "user", content: run.question },
  ]);
  const queries = parseQueries(planRaw, run.question);
  emit(run, { type: "plan", at: now(), queries });

  // 2. research steps (1 paid call each), budget-aware
  // reserve 1 call for synthesis, +1 for the critic when A2A is available
  const reserved = opts.criticSmartAccount ? 3 : 2;
  const findings: { query: string; answer: string }[] = [];
  for (const query of queries) {
    if (!hasBudgetFor(reserved)) {
      emit(run, {
        type: "budget-stop",
        at: now(),
        reason: `stopping early: $${spentUsd.toFixed(2)} of $${opts.budgetUsd.toFixed(2)} spent, reserving the rest for synthesis`,
      });
      break;
    }
    try {
      const answer = await ask([
        {
          role: "system",
          content:
            "You are a precise researcher. Answer the question factually in <=150 words. Note uncertainty where it exists.",
        },
        { role: "user", content: query },
      ]);
      findings.push({ query, answer });
      emit(run, { type: "step", at: now(), query, answer });
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        emit(run, { type: "budget-stop", at: now(), reason: error.message });
        break;
      }
      throw error;
    }
  }

  // 3. synthesis (1 paid call), fall back to raw findings if out of budget
  let report: string;
  if (findings.length > 0 && hasBudgetFor(1)) {
    try {
      report = await ask([
        {
          role: "system",
          content:
            "Synthesize the research findings into a clear, structured answer to the user's original question. Cite which sub-question each claim came from.",
        },
        {
          role: "user",
          content: `Question: ${run.question}\n\nFindings:\n${findings
            .map((f, i) => `[${i + 1}] ${f.query}\n${f.answer}`)
            .join("\n\n")}`,
        },
      ]);
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      emit(run, { type: "budget-stop", at: now(), reason: error.message });
      report = fallbackReport(findings);
    }
  } else {
    report = fallbackReport(findings);
  }

  // 4. A2A: the orchestrator redelegates a narrowed sub-budget to the critic,
  // which pays for its own review through the 3-hop chain user -> agent -> critic.
  if (opts.criticSmartAccount && findings.length > 0 && hasBudgetFor(1)) {
    try {
      const subDelegation = await createSubDelegation({
        to: opts.criticSmartAccount.address,
        delegator: opts.agentSmartAccount,
        parentDelegation: opts.userDelegation,
        usdc: chainConfig.usdc,
        maxUsdc: PRICE_USD.toFixed(6),
        maxCalls: 1,
        validForSeconds: 3600,
      });
      emit(run, {
        type: "a2a",
        at: now(),
        from: opts.agentSmartAccount.address,
        to: opts.criticSmartAccount.address,
        capUsd: PRICE_USD,
        maxCalls: 1,
        authority: hashDelegation(opts.userDelegation),
        message:
          "orchestrator redelegates a narrowed sub-budget to the critic — authority chained to the user's original delegation, never exceeding it",
      });
      const criticAsk = askVia(
        makePaidFetch({
          agentSmartAccount: opts.criticSmartAccount,
          delegationChain: [subDelegation, opts.userDelegation],
          onPayment: onPayment("critic"),
        }),
      );
      const review = await criticAsk([
        {
          role: "system",
          content:
            "You are a critical reviewer. In <=120 words, assess the research report: the strongest claim, the weakest claim, and one missing consideration.",
        },
        { role: "user", content: `Question: ${run.question}\n\nReport:\n${report}` },
      ]);
      emit(run, { type: "critique", at: now(), review });
      report += `\n\n— Critic review (paid by the critic itself via A2A redelegation) —\n${review}`;
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        emit(run, { type: "budget-stop", at: now(), reason: `critic: ${error.message}` });
      } else {
        emit(run, {
          type: "status",
          at: now(),
          message: `critic review skipped: ${(error as Error).message}`,
        });
      }
    }
  }

  finish(run, report, spentUsd, calls);
}

function finish(run: ResearchRun, report: string, spentUsd: number, calls: number) {
  emit(run, { type: "result", at: now(), report, spentUsd, calls });
}

/**
 * After a delivered run, the agent invoices a small completion fee from the
 * user's account — redeemed gaslessly through the 1Shot relayer, gas paid in
 * USDC inside the same delegation bundle. memo = run id so incoming webhooks
 * correlate back to this run's event stream.
 */
const COMPLETION_FEE_USD = 0.01;

async function claimCompletionFee(
  run: ResearchRun,
  opts: Parameters<typeof startResearch>[0],
): Promise<void> {
  if (!opts.userSmartAccount) return;
  const paidCalls = run.events.filter((e) => e.type === "payment").length;
  if (paidCalls === 0) return;

  emit(run, {
    type: "relayer",
    at: now(),
    phase: "claiming",
    amountUsd: COMPLETION_FEE_USD,
    message: `agent invoices a $${COMPLETION_FEE_USD.toFixed(2)} completion fee — gasless claim via 1Shot relayer, gas paid in USDC`,
  });

  try {
    const claim = await claimBudgetViaRelayer({
      userSmartAccount: opts.userSmartAccount,
      recipient: opts.agentSmartAccount.address,
      amountUsdc: COMPLETION_FEE_USD.toFixed(2),
      memo: run.id,
      webhookUrl: process.env.RELAYER_WEBHOOK_URL,
    });
    relayerTasks.set(claim.taskId, run);
    const feeUsd = Number(claim.feeUsdcAtoms) / 1e6;
    emit(run, {
      type: "relayer",
      at: now(),
      phase: "submitted",
      taskId: claim.taskId,
      feeUsd,
      amountUsd: COMPLETION_FEE_USD,
      message: `task submitted to 1Shot — relayer fee $${feeUsd.toFixed(2)} USDC bundled in the same delegation, zero ETH`,
    });

    const status = await waitForRelayerTask(claim.taskId);
    const txHash = relayerTxHash(status);
    if (status.status === 200) {
      emit(run, {
        type: "relayer",
        at: now(),
        phase: "confirmed",
        taskId: claim.taskId,
        feeUsd,
        amountUsd: COMPLETION_FEE_USD,
        txUrl: txHash ? chainConfig.explorerTxUrl(txHash) : undefined,
        message: "completion fee confirmed on-chain via 1Shot",
      });
    } else {
      emit(run, {
        type: "relayer",
        at: now(),
        phase: "failed",
        taskId: claim.taskId,
        message: `relayer task ended with status ${status.status}`,
      });
    }
  } catch (error) {
    emit(run, {
      type: "relayer",
      at: now(),
      phase: "failed",
      message: `1Shot claim failed: ${(error as Error).message}`,
    });
  }
}

/** taskId -> run, for webhook correlation (memo carries the run id as backup) */
export const relayerTasks = new Map<string, ResearchRun>();

/** Feed a verified 1Shot webhook into the matching run's event stream. */
export function handleRelayerWebhook(webhook: {
  type: number;
  data: RelayerStatus & { id?: string; memo?: string };
}): boolean {
  const taskId = String(webhook.data.id ?? "");
  const run = relayerTasks.get(taskId) ?? (webhook.data.memo ? runs.get(webhook.data.memo) : undefined);
  if (!run) return false;
  const label =
    webhook.type === 4 ? "submitted on-chain" : webhook.type === 0 ? "confirmed" : "failed";
  const txHash = relayerTxHash(webhook.data);
  emit(run, {
    type: "relayer",
    at: now(),
    phase: "webhook",
    taskId,
    txUrl: txHash ? chainConfig.explorerTxUrl(txHash) : undefined,
    message: `1Shot webhook: ${label} (Ed25519 signature verified)`,
  });
  return true;
}

function fallbackReport(findings: { query: string; answer: string }[]): string {
  if (findings.length === 0) return "No findings — budget exhausted before research could begin.";
  return `Budget exhausted before synthesis. Raw findings:\n\n${findings
    .map((f, i) => `${i + 1}. ${f.query}\n${f.answer}`)
    .join("\n\n")}`;
}

function parseQueries(raw: string, fallback: string): string[] {
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (Array.isArray(parsed)) {
      const queries = parsed.filter((q): q is string => typeof q === "string").slice(0, 3);
      if (queries.length > 0) return queries;
    }
  } catch {
    // fall through
  }
  return [fallback];
}

class BudgetExhausted extends Error {}
