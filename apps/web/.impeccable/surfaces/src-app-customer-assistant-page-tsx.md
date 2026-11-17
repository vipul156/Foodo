---
version: 1
slug: "src-app-customer-assistant-page-tsx"
primary_target: "src/app/(customer)/assistant/page.tsx"
related_targets: ["src/features/commerce/api/index.ts","src/features/commerce/components/chat-thread.tsx","src/features/commerce/components/order-ticket.tsx","src/app/(customer)/layout.tsx"]
---

# /assistant — conversational ordering

**Mode:** Operate. The customer is placing a food order; the surface must be scannable, predictable, and fast, and brand lives only in precision (the ticket as a receipts desk, not a chat app).

**Job:** turn a spoken craving into a priced draft, then hand that draft to the existing cart and checkout. The assistant is a drafting tool, not an autonomous buyer.

## Composition

- Above 1024px: two columns — conversation (`minmax(0,1fr)`, owns the scroll) and a 21rem ticket, sticky at `top-24`.
- Below 1024px: one column; the ticket is hidden and replaced by a fixed bottom bar (`N items · ₹total` + "Review draft") that opens a bottom sheet.
- The composer is always the last thing in the conversation column, never buried under the thread.
- The thread follows the newest turn via `endRef.scrollIntoView`; no manual "jump to latest".

## Authority and truth

- **Pricing is server-owned.** Subtotal is line arithmetic on server unit prices. Delivery, platform fee, and total appear only when the turn returns `checkout_card.pricing` (`deliveryFee = subtotal < 250 ? 49 : 0`, `platformFee = 7`). The UI never invents a fee.
- **Nothing is added to the cart until the customer confirms.** `draft_finalize` prices a draft; the hand-off replays the draft into `/api/cart/*` only after the confirm dialog.
- Failed hand-off clears the cart again, so the customer is never left with half an order; the error names the cause ("the menu may have changed").
- Concurrency: the platform allows one restaurant per cart, so the confirm copy states the cart will be replaced before the button is pressed.

## States that must all exist

| State | Surface |
|---|---|
| Hydrating | Quiet empty shell, `aria-busy` — no auth flash |
| Guest | `GuestGate`: "Order by talking.", log in / browse restaurants |
| Empty (signed in) | `StarterPrompts` + optional "Unfinished drafts" resume rows |
| Thinking | Three composing dots + `sr-only` "Foodo is composing your order" |
| Resumed | Notice message "Picked up your last draft…", ticket hydrated from `/draft` + `/summary` |
| Turn limit (409) | Inline amber block replacing the composer, "Start a new conversation" |
| Session gone (404) | Error message in-thread, session state reset, next message rebuilds |
| Rate limited (429) / 5xx / 401 | Named in `turnErrorMessage`, nothing silently swallowed |
| Over budget | Amber chip in the ticket, "₹X over your ₹Y cap" |
| Building | CTA label becomes `Adding 2 of 5…`; draft button + discard disabled |
| Hand-off failed | Inline `HandoffNotice` above the ticket, plus toast |

## Copy

Second person, plain, specific. No hype, no "AI magic", no exclamation marks. Buttons name the outcome ("Move to checkout", "Build my cart", "Review draft"), never "Submit" or "Continue". Disclosures sit directly under the action they qualify.

## Motion

One authored moment: the assistant reply fades and rises 4px (`tw-animate-css`), which makes the turn feel delivered rather than appended. The composing dots are the only looping animation, and both respect `prefers-reduced-motion`. Nothing else moves on hover except border/text colour.

## Accessibility

`role="log"` + `aria-live="polite"` on the thread; `aria-label="Draft order"` on the ticket; labelled composer with `aria-describedby` hint; native `<details>` for the tool trace (keyboard-operable for free); focus-visible ring from the global token; the sheet and dialog are `role="dialog" aria-modal="true"` with Escape-to-close (via `AiModal`).

## Provenance

Every assistant turn that ran tools exposes a collapsed `<details>` — "N checks" — listing what the agent actually did (searched the menu, chose the restaurant, priced the order). Failures are marked amber and counted in the summary. This is the visible answer to "why did it pick that?".

## Open verification

- Typecheck, eslint, and the Impeccable detector pass on the changed files.
- The authenticated composition has **not** been visually reviewed against a live gateway: the demo login returns 404 from the local rewrite because `API_GATEWAY_URL` is not set in this environment. Points to re-check first: ticket sticky offset under the 64px header, mobile sheet + fixed bar stacking over the customer footer, and the 409 composer replacement.
