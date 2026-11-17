---
version: 1
slug: "src-features-disputes-components-report-problem-tsx"
primary_target: "src/features/disputes/components/report-problem.tsx"
related_targets: ["src/features/disputes/api/index.ts","src/app/(customer)/orders/[id]/page.tsx","src/app/admin/reviews/page.tsx"]
---

# Report a problem — customer dispute modal

**Mode:** Operate. Somebody is annoyed about food they paid for; the surface must be short, calm, and impossible to get lost in.

**Job:** take one complaint, optionally one photo, hand it to the arbitration agent, and stay honest about the wait and the outcome.

## Composition

- One trigger in the order page's action row, next to the payment chip: `Report a problem` → `Report under review` (spinner) → `See the outcome`. Same button throughout, so the state is never a mystery.
- The panel is `AiModal` (`sm:max-w-lg`), bottom-sheet on phones, Escape-to-close.
- Three phases inside one modal, never a wizard: form → waiting → verdict.
- A filed case always wins over the form. One order, one case from this surface; the verdict is the destination, not another complaint form.

## Authority and truth

- **The verdict is the server's.** Status, refund amount, voucher code and the agent's reason come from the case row; nothing is inferred from the customer's complaint.
- `decisionReason` is shown only when the status makes it customer-facing. A `failed` case carries an internal node error in that field — it is withheld and replaced with "The review didn't finish", which is also true.
- The agent's thought graph, telemetry flags and trust score are **not** shown here: they are machine evidence for the reviewer, and they live on `/admin/reviews`.
- Cases are found by order (`GET /api/agent/order/:id/cases`), so the case survives a new device. The 202's `caseId` is held in memory only to cover the gap before the consumer writes the row.
- The photo is re-encoded in the browser (`fileToVerifiedDataUri`, max edge 1280, JPEG q0.8) and capped at ~4M chars, because the whole JSON body must fit Lambda's 6MB sync payload.

## States that must all exist

| State | Surface |
|---|---|
| Empty complaint | Send disabled; "N more characters and you can send it" |
| Reading photo | "Reading photo…" on the attach button, send stays disabled |
| Photo too large / unreadable | Inline destructive line under the control, photo not attached |
| Filing (202) | "Sending…" with spinner, footer buttons hold |
| Queued | "Checking your order", live elapsed clock, case id once known |
| Queued but unwritten | Same wait, no case id yet — the gap is named, not hidden |
| Poll failing | "We lost touch … still trying. Nothing is lost, so closing this is safe." |
| Refunded | "Refund approved", amount in ₹, agent's reason |
| Voucher | "Voucher issued", the code to use |
| Escalated | "A person is taking this one" — no promise of a timeline |
| Rejected | "No refund for this order" + the agent's reason |
| Failed | "The review didn't finish", support will pick it up |
| Bad intake status | 413 / 429 / 502 / 503 / 401 each get their own sentence |

## Copy

Second person, plain, no legalese and no promises the platform cannot keep. Buttons name the act ("Send to support"), never "Submit". The guest and photo hints explain *why* ("a clear photo … usually settles the case faster") instead of ordering the customer around.

## Motion

One authored moment: the spinner on the trigger and in the wait phase; the elapsed clock ticks once a second and respects reduced-motion implicitly (it is text). Nothing else animates.

## Accessibility

Labelled `textarea` and a hidden file input driven by a real `<button>`; `role="alert"` on errors; `aria-live="polite"` on the elapsed clock; the remove-photo control is a labelled button, not a ghost icon; the attached photo carries alt text ("The problem you reported"); `AiModal` supplies `role="dialog"`, `aria-modal`, Escape and scroll lock.

## Open verification

- Typecheck, eslint, and the Impeccable detector pass on the changed files.
- Not visually reviewed against live data: filing needs the orchestrator's SQS consumer and payment provider, which are not reachable from the local rewrite (`API_GATEWAY_URL` unset).
