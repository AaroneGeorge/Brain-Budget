"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ---- types mirrored from server/src/agent/loop.ts ---- */
type AgentEvent =
  | { type: "status"; at: string; message: string }
  | { type: "plan"; at: string; queries: string[] }
  | {
      type: "payment";
      at: string;
      payment: { url: string; status: number; paymentResponse?: string; txHash?: string };
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

interface ServerState {
  chain: { name: string; id: number };
  user: { address: string; usdc: string };
  agent: { address: string };
  critic: { address: string } | null;
  gateway: { address: string; veniceMocked: boolean };
}

interface DelegationView {
  delegate: string;
  delegator: string;
  caveats: { enforcer: string; terms: string }[];
  signature: string;
}

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
const EXPLORERS: Record<number, string> = {
  8453: "https://basescan.org/tx/",
  84532: "https://sepolia.basescan.org/tx/",
};

export default function Home() {
  const [state, setState] = useState<ServerState | null>(null);
  const [question, setQuestion] = useState(
    "What are the tradeoffs between EIP-7702 and ERC-4337 for agent wallets?",
  );
  const [budget, setBudget] = useState(0.05);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [delegation, setDelegation] = useState<DelegationView | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const tapeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/agent/state")
        .then((r) => r.json())
        .then(setState)
        .catch(() => {});
    load();
    const id = setInterval(load, 12_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    tapeRef.current?.scrollTo({ top: tapeRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const start = useCallback(async () => {
    if (running || !question.trim()) return;
    setRunning(true);
    setEvents([]);
    setDelegation(null);
    sourceRef.current?.close();
    try {
      const response = await fetch("/api/agent/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, budgetUsd: budget }),
      });
      const { runId, delegation: signed, error } = await response.json();
      if (error) throw new Error(error);
      setDelegation(signed);
      const source = new EventSource(`/api/agent/research/${runId}/events`);
      sourceRef.current = source;
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as AgentEvent;
        setEvents((prev) => [...prev, event]);
      };
      source.addEventListener("done", () => {
        source.close();
        setRunning(false);
      });
      source.onerror = () => {
        source.close();
        setRunning(false);
      };
    } catch (error) {
      setEvents((prev) => [
        ...prev,
        { type: "error", at: new Date().toISOString(), message: (error as Error).message },
      ]);
      setRunning(false);
    }
  }, [running, question, budget]);

  const lastPayment = [...events].reverse().find((e) => e.type === "payment");
  const spent = lastPayment?.type === "payment" ? lastPayment.spentUsd : 0;
  const calls = events.filter((e) => e.type === "payment").length;
  const result = events.find((e) => e.type === "result");
  const pct = Math.min(100, (spent / budget) * 100);

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="brand">
          Brain<span className="tm">Budget</span>
        </h1>
        <div className="tagline">a research agent that pays for its own brain</div>
      </header>

      <div className="ticker">
        <div className="tick">
          <span className="k">chain</span>
          <span className="v">{state ? `${state.chain.name} #${state.chain.id}` : "…"}</span>
        </div>
        <div className="tick">
          <span className="k">user (delegator)</span>
          <span className="v">{short(state?.user.address)}</span>
        </div>
        <div className="tick">
          <span className="k">user usdc</span>
          <span className="v">{state ? `$${state.user.usdc}` : "…"}</span>
        </div>
        <div className="tick">
          <span className="k">agent (delegate)</span>
          <span className="v">{short(state?.agent.address)}</span>
        </div>
        {state?.critic && (
          <div className="tick">
            <span className="k">critic (a2a)</span>
            <span className="v">{short(state.critic.address)}</span>
          </div>
        )}
        <div className="tick">
          <span className="k">inference</span>
          <span className={`v${state?.gateway.veniceMocked ? " warn" : ""}`}>
            {state ? (state.gateway.veniceMocked ? "VENICE (MOCK)" : "VENICE AI · x402") : "…"}
          </span>
        </div>
      </div>

      <div className="grid">
        <section>
          <h2 className="panel-title">
            <span className="num">01</span>Grant a budget, ask a question
          </h2>

          <div className="ask">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What should the agent research?"
              disabled={running}
            />
            <div className="budget-row">
              <label>delegated budget</label>
              <input
                type="range"
                min={0.02}
                max={0.5}
                step={0.01}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                disabled={running}
              />
              <span className="budget-amount">${budget.toFixed(2)}</span>
            </div>
            <button className="go" onClick={start} disabled={running}>
              {running ? "agent is spending your trust…" : "sign delegation + unleash agent"}
            </button>
          </div>

          <div className="gauge">
            <div className="gauge-top">
              <span className="spent">${spent.toFixed(2)}</span>
              <span className="of">spent of ${budget.toFixed(2)} delegated</span>
            </div>
            <div className="bar">
              <div className="fill" style={{ width: `${pct}%` }} />
              <div className="notches" />
            </div>
            <div className="calls">
              {calls} x402 payment{calls === 1 ? "" : "s"} · each settled on-chain by redeeming the
              delegation
            </div>
          </div>

          {delegation && (
            <div className="contract">
              <div className="stamp">signed</div>
              <h3>Delegation № 7710</h3>
              <div className="sub">erc-7710 · the entire trust artifact · no keys exchanged</div>
              <dl>
                <div className="row">
                  <dt>delegator (user)</dt>
                  <dd>{short(delegation.delegator)}</dd>
                </div>
                <div className="row">
                  <dt>delegate (agent)</dt>
                  <dd>{short(delegation.delegate)}</dd>
                </div>
                <div className="row">
                  <dt>budget cap</dt>
                  <dd>${budget.toFixed(2)} USDC</dd>
                </div>
                <div className="row">
                  <dt>caveat enforcers</dt>
                  <dd>{delegation.caveats.length} on-chain</dd>
                </div>
                <div className="row">
                  <dt>signature</dt>
                  <dd>{delegation.signature.slice(0, 18)}…</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="footnote">
            <b>How it works:</b> the user signs an ERC-7710 delegation capping the agent&apos;s
            spend. Every inference request hits an x402 paywall; the agent redelegates the budget
            down to exactly $0.01 and the MetaMask facilitator settles it on-chain. Overspend is
            rejected by the caveat enforcer — at the contract level, not by trusting the agent.
          </div>
        </section>

        <section>
          <h2 className="panel-title">
            <span className="num">02</span>The agent tape
          </h2>

          <div className="tape">
            <div className="tape-head">
              <span>cognition ledger</span>
              {running ? <span className="live">live</span> : <span>idle</span>}
            </div>
            <div className="tape-body" ref={tapeRef}>
              {events.length === 0 && (
                <div className="empty">
                  <div className="glyph">¢¢¢</div>
                  <p>no thoughts purchased yet</p>
                </div>
              )}

              {events.map((event, i) => (
                <Entry key={i} event={event} explorer={state ? EXPLORERS[state.chain.id] : undefined} />
              ))}

              {result?.type === "result" && (
                <div className="report">
                  <h4>Research report</h4>
                  <div className="body">{result.report}</div>
                  <div className="meta">
                    {result.calls} paid inferences · ${result.spentUsd.toFixed(2)} total · powered
                    by delegated USDC
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Entry({ event, explorer }: { event: AgentEvent; explorer?: string }) {
  const cls = event.type;
  return (
    <div className={`entry ${cls}`}>
      <span className="t">{clock(event.at)}</span>
      <div>
        {event.type === "status" && (
          <>
            <span className="badge">agent</span>
            <span className="body">{event.message}</span>
          </>
        )}
        {event.type === "plan" && (
          <>
            <span className="badge">plan</span>
            <span className="body">research plan acquired</span>
            <ol className="plan-list">
              {event.queries.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          </>
        )}
        {event.type === "payment" && (
          <>
            <span className="badge">
              402 → paid{event.actor === "critic" ? " · critic" : ""}
            </span>
            <span className="amount">$0.01</span>{" "}
            <span className="body">
              {event.actor === "critic"
                ? "critic paid for its own review — 3-hop chain: user → agent → critic"
                : "settled via erc-7710 redelegation"}{" "}
              · total ${event.spentUsd.toFixed(2)}
            </span>
            {event.payment.txHash && explorer ? (
              <a
                className="settle tx-link"
                href={`${explorer}${event.payment.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                settlement tx: {short(event.payment.txHash)} ↗ basescan
              </a>
            ) : (
              event.payment.paymentResponse && (
                <span className="settle">
                  settlement: {event.payment.paymentResponse.slice(0, 64)}…
                </span>
              )
            )}
          </>
        )}
        {event.type === "step" && (
          <>
            <span className="badge">finding</span>
            <span className="q">{event.query}</span>
            <div className="body">{event.answer}</div>
          </>
        )}
        {event.type === "budget-stop" && (
          <>
            <span className="badge">caveat</span>
            <span className="body">{event.reason}</span>
          </>
        )}
        {event.type === "a2a" && (
          <>
            <span className="badge">a2a · redelegate</span>
            <span className="body">{event.message}</span>
            <span className="settle">
              {short(event.from)} → {short(event.to)} · cap ${event.capUsd.toFixed(2)} ·{" "}
              {event.maxCalls} call · authority {event.authority.slice(0, 18)}…
            </span>
          </>
        )}
        {event.type === "critique" && (
          <>
            <span className="badge">critic</span>
            <span className="q">sub-agent review</span>
            <div className="body">{event.review}</div>
          </>
        )}
        {event.type === "relayer" && (
          <>
            <span className="badge">1shot · {event.phase}</span>
            {event.amountUsd !== undefined && (
              <span className="amount">${event.amountUsd.toFixed(2)}</span>
            )}{" "}
            <span className="body">{event.message}</span>
            {event.txUrl && (
              <a className="settle tx-link" href={event.txUrl} target="_blank" rel="noreferrer">
                claim tx ↗ basescan
              </a>
            )}
          </>
        )}
        {event.type === "error" && (
          <>
            <span className="badge">error</span>
            <span className="body">{event.message}</span>
          </>
        )}
        {event.type === "result" && (
          <>
            <span className="badge">done</span>
            <span className="body">
              report delivered — {event.calls} paid calls, ${event.spentUsd.toFixed(2)} spent
            </span>
          </>
        )}
      </div>
    </div>
  );
}
