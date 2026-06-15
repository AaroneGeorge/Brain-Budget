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

/* renders a shortened address as a link to the block explorer (plain text if no chain/base yet) */
function Addr({ address, base }: { address?: string; base?: string }) {
  if (!address) return <>—</>;
  if (!base) return <>{short(address)}</>;
  return (
    <a className="addr-link" href={`${base}${address}`} target="_blank" rel="noreferrer">
      {short(address)}
    </a>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

/* every transaction hash links to BaseScan mainnet, regardless of the run's chain */
const BASESCAN_TX = "https://basescan.org/tx/";
/* accepts a raw tx hash or any explorer URL containing one, always points it at BaseScan mainnet */
const txLink = (hashOrUrl: string) => {
  const hash = hashOrUrl.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? hashOrUrl;
  return `${BASESCAN_TX}${hash}`;
};
const ADDR_EXPLORERS: Record<number, string> = {
  8453: "https://basescan.org/address/",
  84532: "https://sepolia.basescan.org/address/",
};

/* the user's-eye view of a run — drives the "How it works" modal */
const HOW_STEPS: { title: string; body: string }[] = [
  {
    title: "Fund — no ETH anywhere",
    body: "A burner EOA is upgraded into a MetaMask smart account via EIP-7702, holding only USDC on Base. The upgrade itself is relayed gaslessly, with the fee paid in stablecoin.",
  },
  {
    title: "Delegate in one click",
    body: "You sign an ERC-7710 delegation that caps the agent: a USDC spend limit, a max number of calls, and a 24h expiry. The signed delegation is the entire trust artifact — no keys, seed phrases, or API keys ever change hands.",
  },
  {
    title: "Ask a research question",
    body: "Type what you want researched and set the budget slider. That number is the delegation cap — the agent can never exceed it, even if its code is buggy or hostile.",
  },
  {
    title: "Every thought is a paid call",
    body: "The agent plans, then runs research steps. Each step hits an x402 paywall; the agent redelegates the budget down to exactly $0.01 and the MetaMask facilitator settles it on-chain by redeeming your delegation. Venice AI returns the answer — paid by wallet signature, no API key.",
  },
  {
    title: "Watch the spend meter live",
    body: "A budget bar tracks every cent against the cap in real time, and each payment links straight to its settlement transaction on BaseScan.",
  },
  {
    title: "Budget-aware autonomy",
    body: "The agent reserves budget for synthesis and the critic, stopping research early rather than blowing the whole budget. Any over-budget payment is rejected on-chain by the caveat enforcer — at the contract level, not by trusting the agent.",
  },
  {
    title: "A2A critic review",
    body: "Before delivering, the orchestrator redelegates a narrowed sub-budget to a critic sub-agent, which pays for its own review through the 3-hop chain user → agent → critic — authority cryptographically chained to your original grant, never exceeding it.",
  },
  {
    title: "Result, then a gasless invoice",
    body: "You get a synthesized report with the critic's review appended. The agent then invoices a small completion fee, claimed gaslessly through the 1Shot relayer (fee in USDC, zero ETH), streaming claiming → submitted → confirmed with every webhook Ed25519-verified.",
  },
];

export default function Home() {
  const [state, setState] = useState<ServerState | null>(null);
  const [question, setQuestion] = useState(
    "What are the tradeoffs between EIP-7702 and ERC-4337 for agent wallets?",
  );
  const [budget, setBudget] = useState(0.05);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [delegation, setDelegation] = useState<DelegationView | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [showModal, setShowModal] = useState(false);
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
    setAskedQuestion(question.trim());
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
  const addrBase = state ? ADDR_EXPLORERS[state.chain.id] : undefined;

  const downloadPdf = useCallback(async () => {
    if (result?.type !== "result") return;
    // jsPDF is pulled in lazily so it never weighs down the initial load
    const { downloadReportPdf } = await import("./lib/reportPdf");
    downloadReportPdf({
      question: askedQuestion || question,
      report: result.report,
      spentUsd: result.spentUsd,
      calls: result.calls,
      budgetUsd: budget,
      chain: state ? `${state.chain.name} #${state.chain.id}` : undefined,
      delegator: state?.user.address ?? delegation?.delegator,
      agent: state?.agent.address ?? delegation?.delegate,
      generatedAt: new Date(),
    });
  }, [result, askedQuestion, question, budget, state, delegation]);

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="brand">
          Brain<span className="tm">Budget</span>
        </h1>
        <div className="tagline">a research agent that pays for its own brain</div>
        <button className="how-it-works-btn" onClick={() => setShowModal(true)}>
          How it works
        </button>
      </header>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowModal(false)}>
              ✕
            </button>
            <h2>How it works</h2>
            <p className="modal-sub">
              Delegation, not custody — the agent buys its own AI inference under a scoped, revocable
              budget you sign. Here is one run, step by step.
            </p>
            <ol className="modal-steps">
              {HOW_STEPS.map((step, i) => (
                <li key={i}>
                  <span className="step-n">{i + 1}</span>
                  <div className="step-body">
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="modal-note">
              <strong>The guarantee</strong> — the MetaMask caveat enforcers reject anything outside
              that scope at the contract level. The delegation fails closed, so the agent can never
              spend more than you authorized.
            </div>
          </div>
        </div>
      )}

      <div className="ticker">
        <div className="tick">
          <span className="k">chain</span>
          <span className="v">{state ? `${state.chain.name} #${state.chain.id}` : "…"}</span>
        </div>
        <div className="tick">
          <span className="k">user (delegator)</span>
          <span className="v">
            <Addr address={state?.user.address} base={addrBase} />
          </span>
        </div>
        <div className="tick">
          <span className="k">user usdc</span>
          <span className="v">{state ? `$${state.user.usdc}` : "…"}</span>
        </div>
        <div className="tick">
          <span className="k">agent (delegate)</span>
          <span className="v">
            <Addr address={state?.agent.address} base={addrBase} />
          </span>
        </div>
        {state?.critic && (
          <div className="tick">
            <span className="k">critic (a2a)</span>
            <span className="v">
              <Addr address={state.critic.address} base={addrBase} />
            </span>
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
                  <dd>
                    <Addr address={delegation.delegator} base={addrBase} />
                  </dd>
                </div>
                <div className="row">
                  <dt>delegate (agent)</dt>
                  <dd>
                    <Addr address={delegation.delegate} base={addrBase} />
                  </dd>
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
                <Entry key={i} event={event} addrExplorer={addrBase} />
              ))}

              {result?.type === "result" && (
                <div className="report">
                  <div className="report-head">
                    <h4>Research report</h4>
                    <button className="pdf-btn" onClick={downloadPdf} title="Download as PDF">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      Download PDF
                    </button>
                  </div>
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

function Entry({
  event,
  addrExplorer,
}: {
  event: AgentEvent;
  addrExplorer?: string;
}) {
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
            {event.payment.txHash ? (
              <a
                className="settle tx-link"
                href={txLink(event.payment.txHash)}
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
              <Addr address={event.from} base={addrExplorer} /> →{" "}
              <Addr address={event.to} base={addrExplorer} /> · cap ${event.capUsd.toFixed(2)} ·{" "}
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
              <a className="settle tx-link" href={txLink(event.txUrl)} target="_blank" rel="noreferrer">
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
