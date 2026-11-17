---
version: 1
slug: "src-app-admin-dispatch-page-tsx"
primary_target: "src/app/admin/dispatch/page.tsx"
related_targets: ["src/features/dispatch/api/index.ts","backend/admin-service/src/controllers/dispatch.ts","backend/ai-dispatch/app/api/routes.py"]
---

# /admin/dispatch — the unassigned pool

**Mode:** Operate. An ops reading at a glance whether tonight is going badly; numbers must be honest before they are pretty.

**Job:** show the ready orders the AI dispatch swarm could not hand to a rider, and be clear that this page is a read, not a control.

## Composition

- Header (title, one-line job, stuck-count chip, refresh with age) → weather strip when degraded → four counters → the pool.
- Counters sit in a `2 × 2` on phones and `4 × 1` from `sm:`, each a label/value pair, no icons competing with the digits.
- The pool is a divided list, one line per order: id, restaurant, prep time, waiting time. No map: coordinates are not what an operator acts on, the wait is.
- Everything is above the fold on a laptop; the explanatory footnotes sit directly under the block they qualify.

## Authority and truth

- **The counters are per-container.** `DispatchHealth` lives on the warm Lambda singleton, so it resets on every cold start. The page prints that limitation instead of implying a platform trend it cannot support.
- **The pool is the swarm's own table read**, filtered to unexpired rows; the page does not compute "assigned" or "live" itself.
- `STUCK_MINUTES = 15` is the page's only opinion, and it is labelled as such: past that, an order is a service failure rather than a queue.
- The footnote states the real retry behaviour (retried when the next ready order arrives, expires with its TTL of 2h by default) so no one assumes a background sweeper is watching.
- Nothing here writes. `POST /api/dispatch/simulate` exists in the service and is deliberately **not** wired to a button: it consumes real dispatch capacity.

## States that must all exist

| State | Surface |
|---|---|
| Loading | Single centred spinner card — the whole page is one read |
| Error | "Couldn't read the swarm" + "Dispatch keeps running without this page — the pool is a read" + retry |
| Weather degraded | Amber strip above the counters, naming what changed (wider radius, harder batching) |
| Pool empty | "Nothing parked" + "Every ready order went straight to a rider." |
| Pool populated | Rows with a waiting chip; past 15 min the chip turns destructive and the header counts them |
| Sub-minute waits | "under a minute", never "0 min" |

## Copy

Operator voice, declarative, no alarm. Failures explain that the business keeps running without this screen. Numbers are never given false precision — seconds become minutes, minutes become `1h 12m`.

## Motion

One authored moment: the refresh icon spins while fetching; the 15s refresh is silent (no flash, no skeleton re-entry). Nothing else moves.

## Accessibility

Counters are label/value text pairs, not icon-only tiles; the stuck chip and the waiting chip carry words as well as colour; the refresh button is a real `<button>` with its state in the label; the pool is an `<ul>` with a stable key per order.

## Open verification

- Typecheck, eslint, and the Impeccable detector pass on the changed files.
- Not visually reviewed against live data: the pool needs `ai-dispatch` reachable with a matching `INTERNAL_SERVICE_KEY`, and real parked orders in the dispatch-state table.
