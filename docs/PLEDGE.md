# PledgeVault — Writing a verifiable promise

GenLayer validators can only judge what they can **fetch and read**. To make a
pledge that the AI arbiter can resolve fairly, follow these conventions.

## The statement

Write the promise so that "kept" is checkable from public evidence:

- **Good:** "I will publish a tagged `v1.0` GitHub release of `acme/widget` with
  working install instructions by the deadline."
- **Weak:** "I will make good progress on my project." (Not objectively
  checkable — likely resolves PARTIAL or BROKEN.)

## The verification URL

Point `verify_url` at where the evidence will exist at resolution time:

- a GitHub release / tag / PR page,
- a published blog post or changelog entry,
- a deployed website or app URL,
- a public document.

Must be **HTTPS**. If the page is missing, empty, or unrelated when `resolve` is
called, the arbiter treats the promise as **not kept**.

## Verdicts

| Verdict | Meaning | Funds go to |
|---------|---------|-------------|
| **KEPT** | Evidence clearly shows the specific promised outcome, by the deadline | maker (stake + reward pool) |
| **PARTIAL** | Only part of the promise is demonstrated | split maker / beneficiary |
| **BROKEN** | Evidence absent, unrelated, or shows the promise unfulfilled | beneficiary |

A 2.5% protocol fee is taken on settlement. Anyone may open a bonded **dispute**
during the dispute window with additional evidence; a dispute that changes the
verdict has its bond refunded.
