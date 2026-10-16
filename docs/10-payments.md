# 10 — Payments

All of it lives in `backend/utils-service/`, plus the payment consumer in
restaurant-service and the order repository in `@foodo/backend-common/dynamo`.

---

## 1. The one invariant

> **Only a signature-verified provider webhook can mark an order paid.**

There is deliberately **no client-driven verify endpoint**. A browser can lie about a
payment; an HMAC over the raw request body cannot. The client therefore *polls* a
read-only status endpoint and waits for the webhook.

---

## 2. Payment flow — Razorpay

```
Browser  POST /api/utils/payment/create  { orderId }
   │
utils   claimOrderForPayment(orderId, "razorpay")        ← ATOMIC conditional update
        Condition: attribute_exists(pk)
                   AND paymentStatus <> "paid"
                   AND status <> "cancelled"
        │
        ├─ returns attachedProviderOrderId?
        │     YES → 200 { razorpayOrderId: <same>, key }      ← idempotent re-issue
        │
        └─ NO  → razorpay.orders.create({
                      amount: claim.amount * 100,            ← paise
                      currency: "INR",
                      receipt: orderId,
                      notes: { orderId },                    ← rides on every webhook payment
                    })
                attachProviderOrder → SNS payment.intent.created (best-effort)
                → 200 { razorpayOrderId, key }
```

Three deliberate properties:

1. **The amount comes from the claim**, not the request. A client cannot ask to be
   charged ₹10 for a ₹900 order.
2. **`notes: { orderId }`** means the webhook can resolve the internal order id with no
   API round-trip.
3. **Retry storms are safe.** A second click returns the *same* `razorpayOrderId` instead
   of creating a duplicate provider order.

If the attach publish fails, the error is logged as
`[ALERT][RECONCILE] Failed to attach razorpay order …` and the request still succeeds —
worst case is one orphan provider intent that reconciliation flags.

---

## 3. Payment flow — Stripe

```
Browser  POST /api/utils/payment/stripe/create  { orderId }
   │
utils   claimOrderForPayment(orderId, "stripe")          ← same atomic claim
        ├─ attached session id exists?
        │     YES → retrieve it; if it still has a url, return it
        │            (no url, e.g. expired → fall through and create a fresh one)
        │
        └─ NO → stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    mode: "payment",
                    line_items: [{ price_data: {
                        currency: "inr",
                        product_data: { name: "Order Payment" },
                        unit_amount: claim.amount * 100,
                      }, quantity: 1 }],
                    metadata: { orderId },
                    success_url: `${frontend}/payment/success?orderId=…&session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${frontend}/payment/cancel`,
                  },
                  { idempotencyKey: `order_${orderId}` })   ← Stripe-native
                attachProviderOrder → SNS payment.intent.created
                → 200 { url }
```

`orderId` rides in the **return URL** as well as the metadata, so the success page can
poll the status endpoint immediately after the redirect — it does not need to wait for the
webhook to arrive before it starts polling.

`getFrontendOrigin(req)` resolves the base dynamically: `Origin` header →
`x-forwarded-host` + `x-forwarded-proto` → `Host` (localhost/127.0.0.1 ⇒ http) →
`FRONTEND_URL` → `http://localhost:3000`. So preview deploys get correct redirect URLs
without a redeploy.

---

## 4. Webhooks — the source of truth

### Razorpay

```
POST /api/utils/payment/webhooks/razorpay
Headers: x-razorpay-signature, x-razorpay-event-id
```

1. `req.body` is a **raw Buffer** (`express.raw({ type: "application/json" })` is
   mounted for this path *before* any JSON parser).
2. HMAC-SHA256 over the raw bytes with `RAZORPAY_WEBHOOK_SECRET` → hex.
3. Compared with `crypto.timingSafeEqual`, **after** an equal-length check (the length
   check exists because `timingSafeEqual` throws on a length mismatch, which would become
   an unhandled 500).
4. `type` must be `payment.captured` or `order.paid`; anything else → `200 "Event ignored"`.
5. `isDuplicateEvent(x-razorpay-event-id)` → `200 "Duplicate event"` if already seen.
6. Resolve `orderId`: `payment.notes.orderId` → `orderEntity.receipt` →
   `razorpay.orders.fetch(payment.order_id).receipt`.
7. Unresolvable → `400 "Cannot resolve orderId"`.
8. `publishPaymentSuccess({ orderId, paymentId, provider: "razorpay" })`.

A **500** tells Razorpay to redeliver, which is safe thanks to the dedupe marker and the
idempotent consumer.

### Stripe

```
POST /api/utils/payment/webhooks/stripe
Header: stripe-signature
```

1. `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)` — verifies
   and throws on mismatch.
2. `event.type` must be `checkout.session.completed`; else `200 "Event ignored"`.
3. `isDuplicateEvent(event.id)` → `200 "Duplicate event"`.
4. `session.metadata.orderId` → `400` if absent.
5. `session.payment_status` must be `"paid"`. If it is not (async methods), →
   `200 "Payment not settled"` and **the order is not marked paid**. The settled event
   arrives separately.
6. `publishPaymentSuccess({ orderId, paymentId: session.id, provider: "stripe" })`.

Any error returns **400**, which makes Stripe stop retrying bad traffic. The source comment
notes this deliberately: signature failures are not worth a retry storm.

---

## 5. What happens after the webhook

```
SQS  foodo-infra-<stage>-payment   { type: "PAYMENT_SUCCESS", data }
   │
Restaurant  paymentConsumer  (batchSize 5, reportBatchItemFailures)
   ├─ markOrderPaid(orderId)
   │     SET paymentStatus = "paid", status = "placed"
   │     REMOVE expiresAt, ttl                    ← a paid order can never be swept
   │     WHERE paymentStatus <> "paid"            ← idempotent
   │   null ⇒ return   (already paid — redelivery)
   │
   ├─ clearCart(order.userId)                     ← BEFORE any notification
   │
   └─ order:new      → restaurant:{restaurantId}   { orderId }
      order:new      → user:{restaurant.ownerId}   { orderId }
      order:update   → user:{order.userId}         { orderId, status: "placed" }
```

Cart-clearing first is intentional: any cart refetch triggered by the sockets immediately
below must observe an empty cart.

---

## 6. Webhook deduplication

`config/webhookDedupe.ts` → table `foodo-infra-<stage>-webhook-dedupe`, TTL 24 h.

```ts
PutCommand({
  Item: { eventId, seenAt: now, ttl: now + 86400 },
  ConditionExpression: "attribute_not_exists(eventId)",
})
```

| Outcome | Interpretation | Action |
|---|---|---|
| Success | first sighting, this caller claimed the marker | `false` → process |
| `ConditionalCheckFailedException` | already seen | `true` → `200 "Duplicate event"` |
| **Any other error** | the dedupe store is unavailable | `false` → **process anyway** |

That third row is the important one. The downstream consumer is idempotent
(`paymentStatus <> paid`), so processing a duplicate is a harmless no-op — whereas dropping
a genuine payment would strand a real customer's order. Fail **open**, and log.

The old in-memory window only protected one process, which is meaningless across Lambda
containers.

---

## 7. Reconciliation — the safety net for lost webhooks

`config/reconciliation.ts`, EventBridge **`rate(1 hour)`**, 256 MB / 120 s.
Tail it with `pnpm run logs:reconcile`.

```
1. Query GSI payment-status:
     paymentStatus = "pending" AND paymentIntentInitiatedAt <= (now - 20 min)
     Limit: 100

2. For each candidate, ask the PROVIDER for the truth:
```

**Razorpay:**

| Provider status | Action |
|---|---|
| `paid` | find the captured payment → re-publish `PAYMENT_SUCCESS` → log *"republished (captured on provider, webhook was missed)"* |
| `created` | *"still pending on provider"* |
| anything else | ⚠ `ORPHAN:` / `unexpected provider status` → `[ALERT][RECONCILE] … MANUAL INSPECTION REQUIRED` |

**Stripe:**

| Provider state | Action |
|---|---|
| `payment_status === "paid"` | re-publish `PAYMENT_SUCCESS` |
| `status === "expired"` | ⚠ `ORPHAN: session expired without payment` → manual inspection |
| otherwise | *"still pending on provider"* |

**This is why the `paymentIntentInitiatedAt` attribute is mirrored flat at the top level of
the order item** — a GSI cannot reach into a nested map. `stampPaymentIntent` keeps the
mirror in sync. Without it this query would be a full table scan.

---

## 8. Cash on delivery

The simplest path, and the only one that writes `paymentStatus: "paid"` synchronously:

```
createOrder:
  isCod = paymentMethod === "cod"
  expiresAt = isCod ? null : now + 15 min
  paymentStatus = isCod ? "paid" : "pending"

  createOrder(input, isCod ? { userId } : undefined)
    └─ TransactWriteItems:
         Put    orders   (the order, already paid)
         Delete carts   (Key: { pk: "CART#<userId>" })     ← only for COD

  then immediately emit order:new ×2 + order:update
```

COD has no payment window and no TTL, so a COD order can never be swept out from under a
rider.

---

## 9. The 15-minute payment window

| Situation | TTL attribute |
|---|---|
| Online order created | `ttl = now + 15 min`, `expiresAt` ISO |
| Payment succeeds | `markOrderPaid` does `REMOVE expiresAt, ttl` — removed immediately |
| Order cancelled | `cancelOrder` sets `status = cancelled`; `ttl` remains but the row is no longer claimable |

So DynamoDB sweeps only genuinely abandoned unpaid orders. Expired rows are also rejected
by `claimOrderForPayment` (`attribute_exists(pk)` fails once the row is gone), and
`isValidOrderId` makes a malformed id fail loudly rather than be misread as "expired".

---

## 10. Legacy: `POST /api/order/payment/claim/{orderId}`

Still declared in restaurant-service, guarded by `x-internal-key === INTERNAL_SERVICE_KEY`,
returning `{ orderId, amount, currency: "INR", attachedProviderOrderId }` or `409`.

**utils-service does not call it.** It claims directly against the shared orders table — the
same repository function — because DynamoDB *is* the consistency point and an HTTP hop
would add a failure mode for nothing. The route is retained for compatibility.

Note this endpoint needs **no user session**, which is why it is public at the gateway: the
internal key is the only authentication.

---

## 11. Circuit breaker — `runProvider`

`config/http.ts` wraps provider SDK calls in `opossum`:

```ts
const outcome = await runProvider(() => razorpay.orders.create({ … }));
```

A provider outage trips the breaker instead of burning Lambda duration on repeated
timeouts. `opossum` is still in the workspace dependency catalog for this purpose.

---

## 12. Rate limits

| Endpoint | Limit | Rationale |
|---|---|---|
| `POST /payment/create` | **10 / min** | money-adjacent, abuse-prone |
| `POST /payment/stripe/create` | **10 / min** | same |
| `POST /payment/webhooks/*` | **300 / min** | provider-originated and signature-verified, but a runaway redelivery loop must not spin the function |

Both are in-memory `express-rate-limit`, so they are per warm container. The source
explicitly frames API Gateway usage plans / throttling as the real per-IP enforcement
point for a serverless deployment.

---

## 13. Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID` | utils | returned to the client as `key` for checkout |
| `RAZORPAY_KEY_SECRET` | utils | server SDK only |
| `RAZORPAY_WEBHOOK_SECRET` | utils | HMAC verification of Razorpay webhooks |
| `STRIPE_SECRET_KEY` | utils | server SDK only |
| `STRIPE_WEBHOOK_SECRET` | utils | webhook signature verification |
| `FRONTEND_URL` | utils | fallback origin for Stripe redirect URLs |
| `ORDERS_TABLE` | utils | claims / reconciliation reads |
| `WEBHOOK_DEDUPE_TABLE` | utils | dedupe markers |
| `PAYMENT_QUEUE_URL` / `PAYMENT_QUEUE_ARN` | utils | publishing payment success |
| `INTERNAL_SERVICE_KEY` | restaurant | the legacy claim endpoint's header check |

All are injected by IaC from `${env:VAR, ''}` with empty-string defaults — so a missing
key fails loudly at the first real call rather than at deploy time. `PAYMENT_QUEUE_URL` is
the one exception that throws immediately (`"PAYMENT_QUEUE_URL is not configured"`).

---

## 14. Money-flow summary table

| Step | Actor | Transport | Guard | On failure |
|---|---|---|---|---|
| Claim | utils | DynamoDB conditional | `paymentStatus <> paid AND status <> cancelled` | `409`, nothing created |
| Create intent | utils → provider | HTTPS via `runProvider` | amount from the claim | 500, client retries → **same** intent |
| Attach | utils → restaurant | SNS `payment.intent.created` | conditional `stampPaymentIntent` | logged `[ALERT][RECONCILE]`; orphan flagged |
| Pay | user | provider-hosted page | — | order stays `pending` |
| Fulfill | provider → utils | HTTPS webhook | HMAC over raw bytes + dedupe | 500/400 → redelivery or drop |
| Mark paid | utils → restaurant | SQS | `paymentStatus <> paid` | retry → no-op |
| Notify | restaurant → realtime | SNS fanout | fire-and-forget | logged; UI refetches on next load |
| Verify | any time | hourly cron | provider is the source of truth | re-publishes the success |