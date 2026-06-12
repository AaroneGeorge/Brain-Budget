# Smart Accounts Kit — developer experience notes (Best Feedback track)

DX issues, doc gaps, and wins encountered while building BrainBudget with
`@metamask/smart-accounts-kit` v1.6.x and `@metamask/x402` v0.2.x, June 12–15 2026.
Each entry: what we tried, what happened, what would have helped.

## Docs

- **Facilitator hostname inconsistency:** the x402 seller guide's network table lists the
  facilitator at `tx-sentinel-base-*.dev-api.cx.metamask.io` while the code sample on the same
  page uses `api.cx.metamask.io`. One of these should be corrected, or the difference explained.
  *(found during pre-build research — to be confirmed against live endpoints)*

## API / runtime

- **x402 buyer guide creates an account the facilitator rejects.** The "Pay for an x402 API
  with delegation" guide builds the buyer as a `Implementation.Hybrid` smart account. Following
  it verbatim, the MetaMask facilitator rejects verification with
  `invalid_exact_evm_erc7710_account_not_delegated` — "delegator EOA must complete an EIP-7702
  upgrade delegating to EIP7702StatelessDeleGator before ERC-7710 verify or settle". The
  facilitator only accepts 7702-upgraded EOAs as erc7710 delegators, but no x402 doc page
  mentions this. Suggest: state the 7702 requirement in the buyer guide and link the EIP-7702
  quickstart. (Found June 12; facilitator: tx-sentinel-base-sepolia.)
- **Error surface for rejected payments is invisible to buyers.** When the facilitator rejects
  a payment, `wrapFetchWithPayment` surfaces a bare second 402 with an empty body — the
  `invalidReason` from /verify is dropped. We had to call the facilitator's /verify endpoint
  manually to discover the reason above. Propagating `invalidReason` into the client error
  would have saved an hour.
- **EIP-7702 quickstart only covers self-submitted authorizations.** For sponsored upgrades
  (another wallet pays gas — the common onboarding case, and what relayers like 1Shot do), the
  `executor: 'self'` nonce nuance inverts and a wrong combination is *silently skipped* by the
  chain rather than reverting. A note in the quickstart would help.
- **`parentPermissionContext` ordering is undocumented.** `createx402DelegationProvider`
  (experimental) accepts a `parentPermissionContext` for redelegation chains, but nothing says
  which way the array runs. We had to read the dist source to learn it's **leaf-first**:
  `existingDelegations[0]` is treated as the immediate parent and the *last* element's
  delegator as the root. Passing `[userDelegation, subDelegation]` instead of
  `[subDelegation, userDelegation]` builds a chain that fails at verify with no hint why.
  One sentence in the typedoc ("ordered from immediate parent to root") would fix this.
  (Found June 12 while building the A2A 3-hop chain.)
- **`hashDelegation` is only exported from `@metamask/smart-accounts-kit/utils`,** while its
  siblings `createDelegation`/`signDelegation` live on the package root. Minor, but the
  asymmetry costs a round-trip to the type declarations.

## 1Shot relayer notes

- **`authorizationList` accepts exactly one entry per task** (`Authorization list must
  contain exactly one entry`). Onboarding a multi-agent system (user + orchestrator + critic,
  all zero-ETH) therefore takes one chained task per account instead of one type-4 tx with
  three authorizations — which the EIP itself would allow. If this is an internal constraint,
  documenting it would help; if not, batching would make multi-agent bootstrap one task.
- **A delegation signed by a not-yet-upgraded 7702 account verifies in the same tx as its
  authorization.** We signed `signDelegation` from a codeless EOA, submitted it with the
  EIP-7702 authorization in one relayer task, and redemption succeeded. Excellent property —
  worth stating in the docs because it's the difference between "bootstrap then delegate"
  (two steps) and true one-shot onboarding.

## Wins worth keeping

- `llms-smart-accounts-kit-full.txt` is excellent for context-loading coding agents — single
  410KB file covered nearly every question we had.
- **The facilitator settles 3-hop delegation chains out of the box.** We redelegated
  user → agent → critic and the critic's x402 payment (with
  `parentPermissionContext = [subDelegation, userDelegation]`) verified and settled first try
  on Base Sepolia. A2A coordination needs zero special-casing — worth advertising loudly.
- `createDelegation({ parentDelegation, scope })` narrowing + on-chain authority chaining is a
  genuinely clean primitive: the sub-agent's cap can never exceed the user's original grant,
  and that's enforced by the DelegationManager, not by our code.
