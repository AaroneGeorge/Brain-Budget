import { EventEmitter } from "node:events";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import type { SignedDelegation } from "@brainbudget/shared";
import { makePaidFetch, type PaymentEvent } from "../buyer.js";
import { INFERENCE_PRICE } from "../config.js";

export type AgentEvent =
  | { type: "status"; at: string; message: string }
  | { type: "plan"; at: string; queries: string[] }
  | { type: "payment"; at: string; payment: PaymentEvent; spentUsd: number; budgetUsd: number }
  | { type: "step"; at: string; query: string; answer: string }
  | { type: "budget-stop"; at: string; reason: string }
  | { type: "result"; at: string; report: string; spentUsd: number; calls: number }
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
}): ResearchRun {
  const run: ResearchRun = {
    id: `run-${++runCounter}-${Date.now().toString(36)}`,
    question: opts.question,
    events: [],
    emitter: new EventEmitter(),
    done: false,
  };
  runs.set(run.id, run);
  void executeRun(run, opts).catch((error) => {
    emit(run, { type: "error", at: now(), message: (error as Error).message });
    run.done = true;
    run.emitter.emit("done");
  });
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

  const paidFetch = makePaidFetch({
    agentSmartAccount: opts.agentSmartAccount,
    userDelegation: opts.userDelegation,
    onPayment: (payment) => {
      spentUsd += PRICE_USD;
      calls += 1;
      emit(run, { type: "payment", at: now(), payment, spentUsd, budgetUsd: opts.budgetUsd });
    },
  });

  const ask = async (messages: { role: "system" | "user" | "assistant"; content: string }[]) => {
    const response = await paidFetch(opts.inferenceUrl, {
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
  const findings: { query: string; answer: string }[] = [];
  for (const query of queries) {
    if (!hasBudgetFor(2)) {
      // reserve 1 call for synthesis
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

  finish(run, report, spentUsd, calls);
}

function finish(run: ResearchRun, report: string, spentUsd: number, calls: number) {
  emit(run, { type: "result", at: now(), report, spentUsd, calls });
  run.done = true;
  run.emitter.emit("done");
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
