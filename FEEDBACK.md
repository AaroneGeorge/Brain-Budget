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

## Wins worth keeping

- `llms-smart-accounts-kit-full.txt` is excellent for context-loading coding agents — single
  410KB file covered nearly every question we had.
