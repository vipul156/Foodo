---
version: 1
slug: "src-app-admin-reviews-page-tsx"
primary_target: "src/app/admin/reviews/page.tsx"
related_targets: ["src/features/disputes/api/index.ts","backend/admin-service/src/controllers/reviews.ts"]
---

# /admin/reviews — AI escalation queue

**Mode:** Operate. An admin triaging money disputes; speed of comprehension beats expression, and the density has to survive a 13-inch laptop at 9am.

**Job:** read one escalated case well enough to act, then clear it from the queue. The agent has already done the investigation — the reviewer is not re-doing it.

## Composition

- Above 1024px: `minmax(0,22rem)` queue rail + flexible detail panel, the panel sticky at `top-24` so scrolling a long brief never loses the "Mark handled" action.
- Below 1024px: one column — the queue first, then the selected detail. Selection is state, not routing: triage means reading many briefs without page loads.
- Default selection is the first (newest) item, so the panel is never empty while the queue is not.

## Authority and truth

- **The brief is the agent's own writing.** `summary` is rendered line by line; `Label: value` lines become definition rows, and anything else keeps its place as a note. The UI never rewrites, summarizes, or reorders that text.
- **Resolving is bookkeeping, not payment.** "Mark handled" only closes the work item and records who did it. The copy says the money move happens at the payment provider *before* the button, so no one believes the click issues a refund.
- Priority is a real field (`low` / `normal` / `high`), surfaced as a dot in the rail and a chip in the panel — `high` is when the delivery telemetry flagged a detour.
- The queue is the server's list: pending only, newest first, refetched every 20s. There is no local mutation of the list beyond invalidation.

## States that must all exist

| State | Surface |
|---|---|
| Loading | Three skeleton rows, no spinner-only screen |
| Empty | "Nothing waiting" + "New ones appear here as soon as the agent hands them over" |
| Error | Named failure, "nothing is lost — the items are still parked", explicit retry |
| Refreshing | Button label carries the age ("Updated 3 min ago"), icon spins |
| Closing | Button becomes `Closing…` with a spinner; the item disappears on success |
| Already closed (404) | Toast "That item was already closed" — two admins, one queue |
| High priority present | Destructive-tinted count chip in the header, next to refresh |

## Copy

Plain, operational, no "AI" theatre. "Disputes the AI agent couldn't settle on its own. It handles the rest without you." Field labels are the agent's own; the footer states the consequence of the click before the click.

## Motion

One authored moment: the refresh icon spins while fetching, and closed rows leave by list reflow — no exit animations. Nothing else moves.

## Accessibility

Rows are real `<button>`s with `aria-current` on the selected one; the detail panel is a `<dl>` of the agent's fields; the resolve button carries its busy label rather than only a spinner; the priority chip is text, not colour alone; the header chip pairs the icon with the count.

## Open verification

- Typecheck, eslint, and the Impeccable detector pass on the changed files.
- Not visually reviewed against live data: the queue needs real escalated cases in `foodo-<stage>-review-queue`, which only the arbitration consumer writes.
