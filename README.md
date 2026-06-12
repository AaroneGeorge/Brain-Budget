# 🧠 BrainBudget — a research agent that pays for its own brain

**MetaMask Smart Accounts Kit × 1Shot API × Venice AI Dev Cook-Off submission**

BrainBudget is an autonomous research agent with **no API keys and no custody of your funds**. You grant it a scoped, caveated, revocable on-chain budget using an **ERC-7710 delegation** from your MetaMask smart account. The agent then answers research questions by **paying per-request for its own Venice AI inference via x402** — every single LLM call is an on-chain-enforceable micropayment authorized by your delegation, relayed gaslessly, with a live spend-vs-budget meter and receipts you can verify on BaseScan.

> **The problem:** AI agents need spending power to be useful, but giving an agent your private key or credit card is custody, not delegation. Today's "agent wallets" are either fully trusted (the agent can drain you) or fully manual (you approve every action, so it isn't autonomous).
>
> **The answer:** MetaMask Smart Accounts delegations. The user stays self-custodial; the agent receives a *delegation* — a signed, on-chain-enforceable permission with caveats: *spend at most 5 USDC, in at most 20 calls, expiring in 24 hours, only via this payment route*. The Delegation Framework's caveat enforcers reject anything outside that scope **at the contract level**, not by trusting the agent's code.

---

## How it works (user's view)

1. **Fund** — the app upgrades a burner EOA into a MetaMask smart account via **EIP-7702** (`Implementation.Stateless7702` — the MetaMask x402 facilitator requires 7702-upgraded EOAs as delegators), holding USDC on Base. (Headless/embedded by design — the Smart Accounts Kit is signer-agnostic, so the same flow works with the MetaMask extension, Embedded Wallets, Dynamic, or Privy.)
2. **Delegate** — one click grants the agent a delegation: `max 5 USDC` (ERC-20 transfer-amount scope) + `max 20 redemptions` (limited-calls caveat) + `expires in 24h` (timestamp caveat). The signed delegation JSON is displayed — this is the *entire* trust artifact; no keys change hands.
3. **Ask** — type a research question.
4. **Watch it work** — the agent plans, then runs research steps. Each step is a paid x402 request: the UI shows the `402 Payment Required` challenge, the delegation-backed payment, settlement, and the Venice AI response streaming in.
5. **Spend meter** — a live budget bar tracks every cent against the 5 USDC cap, with links to settlement transactions on BaseScan.
6. **Caveat enforcement, on camera** — when the budget (or call limit) is exhausted, the next payment is **rejected on-chain by the caveat enforcer**. The agent detects this, stops gracefully, and reports what it spent. The delegation fails *closed*.
7. **A2A review** — before delivering, the orchestrator **redelegates** a narrowed $0.01 / 1-call sub-budget to a critic sub-agent. The critic pays for its *own* review inference through the three-hop chain `user → agent → critic → facilitator` — authority cryptographically chained to your original grant, never exceeding it.
8. **Result** — a synthesized research report with the critic's review appended, plus a receipt: total spent, calls made, budget remaining.
9. **The agent invoices you** — a $0.01 completion fee, claimed **gaslessly via the 1Shot relayer** (relayer fee paid in USDC inside the same delegation bundle; zero ETH anywhere). Status streams live: claiming → submitted → confirmed, with the BaseScan link.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  USER smart account (EIP-7702 upgraded EOA, headless)    [Base]          │
│   └── signs ERC-7710 delegation                                          │
│        scope: ERC-20 transfer ≤ 5 USDC                                   │
│        caveats: limitedCalls ≤ 20, timestamp ≤ +24h                      │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ delegation (signed JSON — no keys, no custody)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  AGENT (Node service, own 7702 smart account)                            │
│   ├── research loop: plan → query → synthesize → critique                │
│   ├── pays for every LLM call via x402 with                              │
│   │   assetTransferMethod: "erc7710"  (@metamask/x402 buyer client)      │
│   ├── A2A: redelegates a narrowed $0.01 sub-budget to a CRITIC           │
│   │   sub-agent, which pays for its own review through the 3-hop         │
│   │   chain user → agent → critic → facilitator                          │
│   └── completion fee: redeemDelegations relayed by 1SHOT permissionless  │
│       relayer — gas paid in USDC (~$0.01), estimate-first price lock,    │
│       Ed25519-signed status webhooks streamed to the UI                  │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ HTTP request → 402 → X-402-Payment (delegation payload)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  TOOLS SERVER (Express) — x402-paywalled inference gateway               │
│   ├── @x402/express paymentMiddleware                                    │
│   │   + x402ExactEvmErc7710ServerScheme                                  │
│   │   verify/settle via the MetaMask tx-sentinel facilitator             │
│   └── proxies to Venice AI (OpenAI-compatible, streaming)                │
│        └── server wallet pays Venice through Venice's NATIVE x402        │
│            endpoint (USDC top-up on Base, SIWE wallet auth — no API key) │
└───────────────┬──────────────────────────────────────────────────────────┘
                ▼
        Venice AI  api.venice.ai  (private, no-data-retention inference)
```

```
┌──────────────────────────────────────────────────────────────────────────┐
│  WEB UI (Next.js)                                                        │
│  delegation grant · live agent timeline · spend-vs-budget meter ·        │
│  x402 payment receipts · 1Shot webhook feed · BaseScan links             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Two flavors of x402 in one pipeline (and why the gateway exists)

x402 settles payments in different ways. Venice's native x402 endpoint uses **standard settlement** (EIP-3009-style transfer authorization) — great, but it doesn't exercise delegations. The newly published official spec extension, `assetTransferMethod: "erc7710"`, settles via **delegation redemption** instead: the payment header carries an ERC-7710 delegation payload and the facilitator redeems it on the DelegationManager.

BrainBudget demonstrates **both, end to end**:

- **Agent → Tools server:** every inference request is an x402 payment settled by **redeeming the user's delegation** (the `@metamask/x402` erc7710 scheme, MetaMask facilitator). This is the part that makes the agent non-custodial.
- **Tools server → Venice:** the gateway's own wallet pays Venice through Venice's **native x402** top-up flow — wallet-signature auth, zero API keys anywhere in the system.

So the full chain is: *user's caveated delegation → per-request erc7710 micropayment → x402-paid private inference*. Money and authority flow through open standards at every hop.

## Technical implementation

| Layer | What | How |
|---|---|---|
| Smart accounts | Headless 7702 smart accounts for user, agent + critic | `@metamask/smart-accounts-kit` → `toMetaMaskSmartAccount({ implementation: Implementation.Stateless7702, address: eoa.address })` after an EIP-7702 authorization upgrades each EOA (the facilitator rejects non-7702 delegators — see FEEDBACK.md) |
| Delegation | Scoped budget grant | `createDelegation({ scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: USDC, maxAmount: 5_000_000n }, caveats: [limitedCalls(20), timestamp(+24h)] })` → `signDelegation` |
| x402 buyer (agent) | Pay per request with the delegation | `@x402/fetch` `wrapFetchWithPayment` + `x402Erc7710Client` fed by `createx402DelegationProvider` (`@metamask/smart-accounts-kit/experimental`) |
| x402 seller (gateway) | Paywall the inference route | `@x402/express` `paymentMiddleware`, route priced `$0.01`, `extra: { assetTransferMethod: 'erc7710' }`, `x402ResourceServer` + `x402ExactEvmErc7710ServerScheme` |
| Facilitator | Verify + settle erc7710 payments | MetaMask tx-sentinel facilitator (Base / Base Sepolia) |
| Venice payment | Pay for inference, no API key | `venice-x402-client`: x402 USDC top-up on Base + SIWE (`X-Sign-In-With-X`) authenticated, OpenAI-compatible `chat/completions` with streaming; `X-Balance-Remaining` surfaced in UI |
| Gasless relaying | Budget-claim redemptions | 1Shot permissionless relayer (JSON-RPC, no signup): `relayer_getCapabilities` → `relayer_estimate7710Transaction` → `relayer_send7710Transaction`; fee paid in USDC inside the same delegation bundle; `destinationUrl` webhooks (Ed25519-verified against the relayer's JWKS) streamed to the UI |
| Agent loop | Budget-aware autonomy | plan → N research queries → synthesis → A2A critique; checks remaining budget before each step (reserving calls for synthesis + critic), stops under threshold, reports spend; execution always `ExecutionMode.SingleDefault` (several caveats are incompatible with batch mode) |
| A2A redelegation | Critic sub-agent pays for itself | `createDelegation({ parentDelegation, scope: Erc20TransferAmount($0.01), caveats: [limitedCalls(1), timestamp(+1h)] })` signed by the agent; the critic's x402 buyer carries `parentPermissionContext = [subDelegation, userDelegation]` (leaf-first) and the facilitator settles the **3-hop chain** on-chain |

### Networks & key addresses

| Thing | Value |
|---|---|
| Dev chain | Base Sepolia `84532` (free: faucet USDC, 1Shot dev relayer, MetaMask test facilitator) |
| Demo chain | **Base mainnet `8453`** (Venice x402 is mainnet-only) |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| MetaMask facilitator (Base) | `https://tx-sentinel-base-mainnet.dev-api.cx.metamask.io/platform/v2/x402` |
| MetaMask facilitator (Base Sepolia) | `https://tx-sentinel-base-sepolia.dev-api.cx.metamask.io/platform/v2/x402` |
| 1Shot relayer (mainnet / dev) | `https://relayer.1shotapi.com/relayers` / `https://relayer.1shotapi.dev/relayers` |
| 1Shot delegation target (Base) | `0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a` |
| Venice API | `https://api.venice.ai/api/v1` (OpenAI-compatible) |

### Repo layout

```
web/              Next.js UI (delegation grant, agent timeline, spend meter, webhook feed)
server/           Express: x402-paywalled tools gateway + agent runtime + 1Shot webhook receiver
packages/shared/  smart-account / delegation / chain-config helpers shared by web & server
docs/vendor/      pinned upstream docs (Smart Accounts Kit llms.txt, 1Shot relayer skill)
reference/        workshop reference implementation (x402-7710-demo)
FEEDBACK.md       Smart Accounts Kit DX notes collected while building (Feedback track)
```

## Track qualification

| Track | Where to look |
|---|---|
| **Best x402 + ERC-7710** | Every agent inference call is an x402 payment with `assetTransferMethod: 'erc7710'` — buyer: `server/src/buyer.ts`, seller: `server/src/gateway.ts`, settled by the MetaMask facilitator redeeming the user's caveated delegation. Demo video 1:20–2:10. Not cosmetic: remove the delegation and the agent cannot think. |
| **Best Agent** | The agent autonomously plans, buys its own inference, tracks its budget, stops when the caveat enforcer says no, delegates review to a sub-agent, invoices its fee, and reports spend (`server/src/agent/loop.ts`). Smart Accounts Kit is the agent's *only* spending mechanism. |
| **Best use of Venice AI** | 100% of inference is Venice (`llama-3.3-70b`), paid via Venice's **native x402** endpoint with wallet auth — no API key in the entire stack (`server/src/venice.ts`). Venice's no-data-retention privacy is the right substrate for an agent processing your research. Primary demo flow throughout the video. |
| **1Shot Permissionless Relayer** | After each delivered run, the agent's completion fee is a `redeemDelegations` relayed via `relayer_send7710Transaction` — estimate-first with price-lock `context`, gas paid in USDC inside the same delegation bundle, **Ed25519-verified webhook receiver** (`POST /relayer/webhook`) feeding the live UI tape (`server/src/relayer.ts`). Demo video 0:50–1:20. |
| **A2A Coordination** | **Working, settled on-chain:** the orchestrator redelegates a narrowed sub-budget ($0.01, 1 call, 1h expiry) to a critic sub-agent via `createSubDelegation` (`packages/shared/src/delegation.ts`); the critic pays for its own review inference and the facilitator redeems the **three-hop chain** `user → agent → critic` against the user's funds. Authority is `hash(parentDelegation)` — the sub-agent can never exceed the original grant. |
| **Best Feedback** | [`FEEDBACK.md`](./FEEDBACK.md) — DX issues hit while building with `@metamask/smart-accounts-kit` v1.6 + `@metamask/x402` v0.2. |
| **Best Social** | Build-in-public thread on X (linked in submission). |

## Demo video script (≤ 3 min)

| Time | Beat |
|---|---|
| 0:00 | Problem: agents need money; keys and cards are custody. One sentence: "delegation, not custody." |
| 0:20 | User grants the delegation — show the signed delegation JSON with its three caveats highlighted. |
| 0:50 | Agent claims its budget tranche through the **1Shot mainnet relayer** — webhook status updates flip live in the UI (Submitted → Confirmed), BaseScan link opened. |
| 1:20 | Agent researches: each Venice call visibly goes `402 → pay → 200`, spend meter ticks up cent by cent; show `X-Balance-Remaining` from Venice. |
| 1:50 | A2A: orchestrator redelegates $0.01 to the critic; the critic **pays for its own review** — point at the `402 → paid · critic` receipt and the 3-hop chain. |
| 2:10 | The kill shot: over-budget request **rejected on-chain by the caveat enforcer**; agent stops gracefully. |
| 2:30 | Final report with critic review + receipt: spent vs. budget, call count, every settlement tx; agent invoices its completion fee via 1Shot on screen. |
| 2:50 | Track recap card. |

## Run it yourself

```bash
pnpm install
cp .env.example .env        # fill in burner private keys (user, agent, gateway, critic) — see below
pnpm demo:e2e               # Base Sepolia end-to-end: delegate → agent answers → caveat rejection
pnpm dev                    # web UI on :3000, server on :4021
```

- **Base Sepolia (free):** ETH from any Base Sepolia faucet, test USDC from [Circle's faucet](https://faucet.circle.com/). Set `CHAIN=baseSepolia`.
- **Base mainnet (the real demo):** fund the user account with ~$10 USDC and the gateway wallet with ~$5 USDC (one-time Venice x402 top-up). Set `CHAIN=base`. Total cost of a full demo run: well under $1 of actual burn — Venice is ~$0.002/request and 1Shot is ~$0.01/tx.
- The e2e script asserts: ≥2 x402 payments settled, Venice responses non-empty, spend ≤ cap, and the over-budget request **correctly refused**.

## What we'd build next

- ERC-7715 `wallet_grantPermissions` flow so any MetaMask user can grant the budget from the extension UI (the headless flow is signer-agnostic by design, so this is a drop-in).
- Delegation revocation button — instant agent kill-switch.
- A marketplace of erc7710-x402-paywalled tools (search, scraping, code-exec) that any delegated agent can pay for.
- Multi-agent teams with deeper redelegation chains and per-role budgets.

See [`FEEDBACK.md`](./FEEDBACK.md) for Smart Accounts Kit developer-experience notes from this build.
