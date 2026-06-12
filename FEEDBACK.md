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

_(collected during the build)_

## Wins worth keeping

- `llms-smart-accounts-kit-full.txt` is excellent for context-loading coding agents — single
  410KB file covered nearly every question we had.
