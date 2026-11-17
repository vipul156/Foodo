# Foodo — Architecture, Distributed Systems, Reliability & FinOps Audit

**Audit date:** 2026-10-29
**Scope:** 13 Serverless Framework stacks (`infra`, `core`, 9 backend services, `ai-*` tiers), the SST/OpenNext frontend stack, `packages/backend-common` (TS), `packages/pycommon` (Python), and all DynamoDB/SNS/SQS/S3/API-Gateway resources defined in-repo.
**Method:** full read of every `serverless.yml`, the shared emitter/repository libraries, the money path (`claim → webhook → consumer → refund`), the rider saga, the realtime tier, the AI tiers, the admin analytics path, and the Next.js client data layer. Every finding below cites the file and the code/config that causes it.

> This document deliberately **does not repeat** `docs/14-known-gaps.md`. Where an issue is already tracked there it is marked `[known-gaps §x.y]` and the value added here is the concrete fix, not the observation.

---

## Severity scale

| Level | Meaning |
|---|---|
| **Critical** | Loses money, corrupts the order ledger, or grants unauthorised access to third-party data. Fix before the next production traffic increase. |
| **High** | Produces incorrect state, cascading failure, or an unbounded cost/ blast radius under load. Fix within one sprint. |
| **Medium** | Correctness/performance/cost debt that compounds. Fix opportunistically. |
| **FinOps** | Direct AWS spend with no functional benefit. |

---

## Executive summary — the ten things that will actually hurt

| # | Issue | Level | One-line consequence |
|---|---|---|---|
| 1 | Refund cap is read-then-write with no conditional guard (`refund.ts` + `Order.ts`) | **Critical** | Two concurrent refunds both pass the cap check → you refund more than the order was worth. |
| 2 | Provider refund succeeds, ledger write fails, API returns `200 success` (`refund.ts:286`) | **Critical** | Money leaves the account with no record; the cap is then under-counted forever. |
| 3 | Razorpay refunds carry no idempotency key while Stripe ones do (`refund.ts:183` vs `:238`) | **Critical** | A webhook/gateway retry triple-refunds. |
| 4 | `order:ready_for_rider` is published to SQS **and** SNS independently (`order.ts:449`) | **Critical** | The two transports diverge silently; the dispatch swarm misses orders with only a `console.warn`. |
| 5 | `order:track` / `rider:location` have no ownership or role check (`realtime/websocket.ts:83,95`) | **Critical** | Any logged-in customer can watch any rider's live GPS, and can *spoof* GPS into any order room. |
| 6 | `JWT_SECRET`/`COOKIE_SECRET` default to `'dev-only-change-me'` in 6 stacks; `INTERNAL_SERVICE_KEY` defaults to `''` in 5 more | **Critical** | A deploy that forgets one env var silently produces forgeable tokens or an open internal API. |
| 7 | The gateway authorizer accepts **any** JWT signed with the shared secret (`core/authorizer.ts:67`) — no `typ`, no audience | **Critical** | The "socket bootstrap token" is a full-scope API credential for 15 minutes. |
| 8 | Zero `reservedConcurrency`/`maximumConcurrency` anywhere; `dispatchConsumer` is 180 s + 1024 MB + direct SNS invoke | **High** | One ready-order burst opens hundreds of concurrent LLM Lambdas against DynamoDB and the provider quota. |
| 9 | The browser WebSocket reconnects **forever with a 15-minute token it never refreshes** (`socket.ts:39-105`) | **High** | Every tab past the 15-minute mark loops a failing `$connect` every 5 s, indefinitely, forever. |
| 10 | No throttling on the shared HTTP API; `/api/utils/*` and `/api/dispatch/*` are public at the gateway | **High** | An unauthenticated loop on `/api/auth/refresh` costs you a GSI query per request and throttles the table. |

---

## Scorecard

| Dimension | Grade | Rationale |
|---|---|---|
| Event-driven topology | **B** | Genuinely good: SNS push replaced fanout queues, DLQs everywhere, `ReportBatchItemFailures`, visibility = 6× timeout. Loses marks for the dual-write in #4 and the unfiltered realtime subscription. |
| Idempotency / exactly-once thinking | **C** | Excellent on payments and vouchers; absent on refunds and dispatch fan-out. |
| Saga / compensation | **C** | The rider-accept compensation is textbook. Refund and dispatch have none. |
| Microservice boundaries | **D** | Six services read/write the same `OrdersTable` as an integration contract. `backend-common` is a distributed monolith with a *diverged* `isAuth`. |
| Data access patterns | **D+** | N+1 in the cart path, three full-table `Scan`s in production endpoints, GSI `FilterExpression` pagination bugs, `ProjectionType: ALL` on 5 order GSIs. |
| Resilience | **B−** | Breakers and bulkhead pools are real and well placed on the AI tiers — then absent on the `restaurant → ai-verification` hop and missing jitter everywhere. |
| Security / multi-tenancy | **D** | Constant-time internal key, HMAC webhooks, refresh rotation with reuse detection are all correct. Then `dev-only-change-me`, a fail-open `isSeller`, and unauthorised room joins. |
| FinOps | **B−** | NAT is opt-in (0 in dev), logs capped at 14 days, pay-per-request everywhere. Then `AuthorizerResultTtlInSeconds: 0`, five `ALL`-projection GSIs, and no budget alarms. |
| Observability | **D** | No X-Ray/OTel; `dispatch_service` health counters are per-container and therefore meaningless. |

---

# Part A — Critical

## A-01 · The refund cumulative cap is a read-then-write race

**Severity & Impact:** **Critical** — direct monetary loss, and the loss is *invisible* because the ledger is what the cap is derived from.

**Location:**
- `backend/utils-service/src/controllers/refund.ts:136-152`
- `packages/backend-common/src/dynamo/Order.ts:400-430`

```ts
// refund.ts
const facts = toPaymentFacts(order);

// 2) Hard bounds — a refused refund is as important to record as a
//    completed one (fraud tooling watches the block rate).
const refundTotal = refundedTotal(order);
if (refundTotal + refundAmount > Number(order.totalAmount)) {
  await publishRefundEvent("refund.blocked", { ... reason: "CAP_EXCEEDED" });
  return res.status(409).json({ message: "Refund exceeds order total (cumulative cap)", code: "CAP_EXCEEDED" });
}
```

```ts
// Order.ts — attachRefund: NO ConditionExpression at all
export async function attachRefund(orderId: string, refund: OrderRefund): Promise<DynamoOrder | null> {
  const out = await docClient()
    .send(
      new UpdateCommand({
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression:
          "SET #refunds = list_append(if_not_exists(#refunds, :empty), :refund), updatedAt = :now",
        // ← no ConditionExpression
      }),
    )
    .catch(() => null);
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}
```

**The Flaw:**
The comment on line 19 claims `2. PER-ORDER CAP — cumulative refunds ≤ original total`. That claim is only true for *serial* requests. The check is a `GetItem`-derived sum; the write appends unconditionally. This is a classic TOCTOU:

1. Request R1 and R2 both read `refunds: []`, `totalAmount: 100`.
2. Both compute `0 + 100 > 100` → false → both proceed.
3. Both call the gateway. **Both refunds happen — real money, real settlement.**
4. Both append to the list. The order now says ₹200 refunded on a ₹100 order.

DynamoDB's `list_append` is atomic but *not conditional*: it will happily append twice. The cap is enforced by the last process to read, not by the database. The AI agent path makes this worse, not better — `ai-orchestrator/src/tools/actions.ts` does a pre-flight `GET /refund/order/:orderId/claim`, then a separate `POST /refund/execute`. That gap is an arbitrary network round-trip long enough for a legitimate customer-service agent and the refund arbiter to both fire on the same order.

It also cannot self-heal. Once the double refund is written, `refundedTotal(order)` is 200 — every subsequent refund is correctly blocked, but the ₹100 over-refund is permanently invisible to the cap.

**The Fix:**
Move the invariant into the write. DynamoDB cannot sum a list server-side, so keep a scalar counter next to it and guard *that*:

```ts
// packages/backend-common/src/dynamo/Order.ts
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export interface RefundOutcome {
  ok: boolean;
  reason?: "CAP_EXCEEDED" | "NOT_PAID" | "NOT_FOUND";
  order?: DynamoOrder;
}

/**
 * Atomic cumulative-cap-guarded refund append.
 *
 * The cap lives in a scalar `refundedAmount` attribute so the invariant is
 * enforced by DynamoDB, not by whichever request read last. The list append
 * and the counter move together in ONE UpdateItem — they cannot diverge.
 */
export async function attachRefundCapped(
  orderId: string,
  refund: OrderRefund,
  cap: number,
): Promise<RefundOutcome> {
  const nextTotal = Number(refund.amount ?? 0);

  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression:
          "SET #refunds = list_append(if_not_exists(#refunds, :empty), :refund), " +
          "#refundedAmount = if_not_exists(#refundedAmount, :zero) + :amt, updatedAt = :now",
        // Cap + paid-state are enforced by the store, in the same atomic write.
        ConditionExpression:
          "attribute_exists(pk) AND paymentStatus = :paid AND " +
          "if_not_exists(#refundedAmount, :zero) + :amt <= :cap",
        ExpressionAttributeNames: { "#refunds": "refunds", "#refundedAmount": "refundedAmount" },
        ExpressionAttributeValues: {
          ":empty": [],
          ":zero": 0,
          ":refund": [refund],
          ":amt": nextTotal,
          ":cap": cap,
          ":paid": "paid",
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return { ok: true, order: out.Attributes as DynamoOrder };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Could be cap-exceeded OR not-paid; re-read to classify honestly
      // instead of reporting "cap exceeded" for a cancelled order.
      const current = await getOrderById(orderId);
      if (!current) return { ok: false, reason: "NOT_FOUND" };
      if (current.paymentStatus !== "paid") return { ok: false, reason: "NOT_PAID" };
      return { ok: false, reason: "CAP_EXCEEDED" };
    }
    throw err; // throttling / network / validation must NOT look like a business refusal
  }
}
```

Then in `refund.ts`, **delete the pre-flight cap check** (it can stay as a fast-path UX nicety but must not be the enforcement point) and call the guarded write *before* the provider call — see A-02 for the ordering.

> **Note on ordering:** the correct sequence is *reserve → call provider → finalise*. Reserving first means a provider outage leaves a stuck reservation that the reconciliation job expires, which is recoverable. Writing the ledger last means a failed write is unrecoverable, which is what happens today.

**Trade-offs:**
- Adds one attribute (`refundedAmount`) that must be backfilled for existing orders (`update-item` migration setting `refundedAmount = sum(refunds)`), and every writer of `refunds` must maintain it or the cap drifts. Mitigate by making `attachRefund` private to the module and exposing only `attachRefundCapped`.
- A failed provider call now leaves a reservation that needs an expiry sweep. That is strictly better than the current failure mode, but it is new operational surface — the reconciliation job (already running hourly) is the natural owner.
- Rejecting on `ConditionalCheckFailedException` costs one extra `GetItem` on the *failure* path only.

---

## A-02 · A successful provider refund followed by a failed ledger write returns `200 success`

**Severity & Impact:** **Critical** — irreversible money movement recorded as if nothing happened; violates the very invariant the module documents.

**Location:** `backend/utils-service/src/controllers/refund.ts:281-330`

```ts
async function completeRefund(res: Response, args: {...}): Promise<Response> {
  const updated = await attachRefund(orderId, { provider, providerRefundId, amount: refundAmount, ... });

  if (!updated) {
    console.error(
      `[ALERT][REFUND] ${orderId}: provider refund ${providerRefundId} succeeded but the ledger write failed`,
    );
  }

  await publishRefundEvent("refund.completed", { orderId, amount: refundAmount, ... });

  return res.status(200).json({ success: true, provider, providerRefundId, amount: refundAmount, idempotencyKey: `refund:${orderId}` });
}
```

**The Flaw:**
The header comment above this function says:

> *"If the write fails the caller sees a 502 and can retry — the provider refund is idempotent on the same key."*

The code does the opposite. `attachRefund` swallows the error and returns `null`; `completeRefund` logs and **still returns `200 success`**. The caller (the AI agent, or admin tooling) believes the refund is recorded. It is not.

Consequences, in order of nastiness:

1. `refund.completed` is published anyway, so downstream analytics tick a refund that does not exist in the ledger.
2. `refundedTotal(order)` stays low, so the **A-01 cap is now computed against a wrong number** — the next refund can push cumulative payouts past the order total with no block at all.
3. There is no retry, no queue, no DLQ, no outbox. The only durable artefact is a `console.error` line in a log group with 14-day retention. Recovering the truth requires reconciling against Razorpay/Stripe manually.

This is the textbook **dual-write problem**: two systems (payment gateway + order ledger) are mutated without a transactional boundary and without a compensating mechanism.

**The Fix:**
Introduce a single-row intent record that is written *before* the provider is called, so every provider refund has a durable, replayable handle. `RefundLedgerTable` already exists in `infra/serverless.yml:558` and is currently **completely unused** — this is exactly what it is for.

```ts
// packages/backend-common/src/dynamo/RefundLedger.ts
import { PutCommand, UpdateCommand, ConditionalCheckFailedException } from "@aws-sdk/lib-dynamodb";

export type RefundState = "pending" | "succeeded" | "failed";

export interface RefundIntent {
  pk: string;              // REFUND#<orderId>
  sk: string;              // <idempotencyKey>
  orderId: string;
  provider: "razorpay" | "stripe";
  amount: number;
  state: RefundState;
  providerRefundId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  ttl?: number;            // 180 days — audit window, then swept
}

/** Create the intent. Rejects a duplicate idempotency key — this IS the dedupe. */
export async function reserveRefund(intent: Omit<RefundIntent, "state" | "attempts" | "providerRefundId" | "lastError">): Promise<RefundIntent | null> {
  try {
    const row: RefundIntent = { ...intent, state: "pending", attempts: 0, providerRefundId: null, lastError: null };
    await docClient().send(
      new PutCommand({
        TableName: TABLE.refundLedger(),
        Item: row,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return row;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return null; // replay — caller returns the original outcome
    throw err;
  }
}

/** Terminal state. Throws if the row does not exist — a missing ledger row is a bug, not a no-op. */
export async function finaliseRefund(orderId: string, key: string, state: RefundState, providerRefundId: string | null, lastError: string | null = null): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: TABLE.refundLedger(),
      Key: { pk: `REFUND#${orderId}`, sk: key },
      UpdateExpression:
        "SET #s = :state, providerRefundId = :prid, lastError = :err, updatedAt = :now ADD attempts :one",
      ExpressionAttributeNames: { "#s": "state" },
      ExpressionAttributeValues: { ":state": state, ":prid": providerRefundId, ":err": lastError, ":now": new Date().toISOString(), ":one": 1 },
      ConditionExpression: "attribute_exists(pk)",
    }),
  );
}
```

And the controller becomes an explicit three-phase commit:

```ts
// refund.ts — replaces the current straight-line to completeRefund()
const intent = await reserveRefund({ pk: `REFUND#${orderId}`, sk: idempotencyKey, orderId, provider, amount: refundAmount, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ttl: Math.floor(Date.now()/1000) + 180*86400 });

if (!intent) {
  // Replay of a known key — report the recorded outcome, never re-call the gateway.
  const existing = await getRefundIntent(orderId, idempotencyKey);
  return res.status(200).json({ success: true, replayed: true, state: existing?.state, providerRefundId: existing?.providerRefundId });
}

try {
  const refund = await runProvider(() => <provider call>);
  await finaliseRefund(orderId, idempotencyKey, "succeeded", refund?.id ?? null);
  const capped = await attachRefundCapped(orderId, { provider, providerRefundId: refund?.id ?? null, amount: refundAmount, reason: auditReason, at: new Date().toISOString(), initiatedBy: actor }, Number(order.totalAmount));
  if (!capped.ok) {
    // Provider money moved but the order record refused the append.
    // This is now a DETECTED, REPLAYABLE inconsistency, not a silent one.
    await publishRefundEvent("refund.ledger_divergence", { orderId, amount: refundAmount, providerRefundId: refund?.id ?? null, cause: capped.reason });
    return res.status(500).json({ message: "Refund executed but the order ledger rejected it — reconciled automatically", code: "LEDGER_DIVERGENCE" });
  }
  return res.status(200).json({ success: true, provider, providerRefundId: refund?.id ?? null, amount: refundAmount, idempotencyKey });
} catch (err) {
  await finaliseRefund(orderId, idempotencyKey, "failed", null, (err as Error)?.message?.slice(0, 300) ?? "unknown").catch(() => {});
  throw err;
}
```

**Trade-offs:**
- One extra DynamoDB write per refund (negligible — refunds are rare and low-volume by construction).
- `RefundLedgerTable` needs a TTL on `ttl` and PITR (it already has PITR; TTL must be added).
- The `LEDGER_DIVERGENCE` response is a *new* failure mode that did not exist before — but it is a *visible* one, which is the entire point. Alert on `refund.ledger_divergence` and page.
- Splitting `attachRefund` into `reserve → provider → finalise` triples the number of code paths a reviewer must hold in their head. That is the correct price for a money path.

---

## A-03 · Razorpay refunds carry no idempotency key, while Stripe refunds do

**Severity & Impact:** **Critical** — duplicate refunds on retry. Money only.

**Location:** `backend/utils-service/src/controllers/refund.ts:122-126`, `:170-198`, `:238-247`, `:323-329`

```ts
// computed once, at the top
const idempotencyKey = `refund:${orderId}:${refundAmount}:${crypto.createHash("sha256").update(auditReason).digest("hex").slice(0, 16)}`;
```

```ts
// Razorpay branch — the key is nowhere in sight
const refund = await runProvider(() =>
  razorpay.payments.refund(providerPaymentId, {
    amount: Math.round(refundAmount * 100),
    speed: "normal",
    notes: { orderId, reason: auditReason, actor },
  }),
);
```

```ts
// Stripe branch — key present
const refund = await runProvider(() =>
  stripe.refunds.create(
    { payment_intent: paymentIntentId, amount: Math.round(refundAmount * 100), metadata: { orderId, reason: auditReason, actor } },
    { idempotencyKey },
  ),
);
```

```ts
// and the response echoes a DIFFERENT key than the one computed
return res.status(200).json({ ..., idempotencyKey: `refund:${orderId}` });
```

**The Flaw:**
Three separate defects stacked:

1. **No Razorpay idempotency.** `razorpay.payments.refund()` does not accept an idempotency key through this SDK call, and none is supplied. Any retry — a 502 from the fronting CloudFront, an agent retry, a doubled admin click, a VPC/NAT reset after the gateway accepted the request — issues a **second real refund**. Stripe's branch is protected; Razorpay's, which is the primary gateway for an India-market product (`ap-south-1`, INR, `razorpay` checked before `stripe`), is not.

2. **The computed key is never persisted or checked.** The comment at line 120 says *"same order+amount+reason within 24h replays the same outcome instead of double-refunding"*. Nothing in the codebase reads that key. There is no dedupe lookup, no conditional write, no cache. The claim is simply false.

3. **The key in the response is a different string** (`refund:${orderId}`) from the key used for Stripe. A client that stores the returned `idempotencyKey` and sends it back gets a key the server will never match — so client-side retry dedupe is impossible by construction.

**The Fix:**
Razorpay supports an `X-Razorpay-Idempotency-Key` header on refund creation. This SDK version exposes `razorpay.api.post`/`instance.request`, but the robust, gateway-agnostic fix is to make **your** store the dedupe authority (the A-02 `reserveRefund` intent already does this) and additionally pass the header where supported:

```ts
// config/razorpay.ts — a tiny typed wrapper that sets the header on every refund
export async function createRazorpayRefund(
  paymentId: string,
  body: { amount: number; speed: "normal" | "optimum"; notes: Record<string, string>; receipt?: string },
  idempotencyKey: string,
) {
  // razorpay SDK v2 exposes the underlying request; the header is what the
  // API actually de-duplicates on.
  return razorpay.api.post({
    url: `/payments/${paymentId}/refund`,
    data: body,
    headers: { "X-Razorpay-Idempotency-Key": idempotencyKey },
  });
}
```

```ts
// refund.ts
const refund = await runProvider(() =>
  createRazorpayRefund(
    providerPaymentId,
    { amount: Math.round(refundAmount * 100), speed: "normal", notes: { orderId, reason: auditReason, actor } },
    idempotencyKey,
  ),
);
```

And return the **same** key everywhere:

```ts
return res.status(200).json({ success: true, provider, providerRefundId: refund?.id ?? null, amount: refundAmount, idempotencyKey });
```

**Trade-offs:**
- Razorpay's idempotency window is 6 hours, not 24; the `RefundLedgerTable` TTL (180 days) is the durable authority, so the header is defence-in-depth rather than the primary mechanism.
- Using `razorpay.api.post` bypasses the SDK's typed `payments.refund` method — you lose compile-time shape checking. Wrap it in a typed helper (as above) with a narrow interface and a single test.
- If Razorpay changes the header name, the fallback (intent row) still holds. Do not rely on the header alone.

---

## A-04 · `order:ready_for_rider` is dual-written to SQS **and** SNS with no outbox

**Severity & Impact:** **Critical** — two independent transports for one business fact; the AI dispatch swarm silently loses orders.

**Location:** `backend/restaurant-service/src/controllers/order.ts:440-460`

```ts
const readyPayload = { orderId: updated.id, restaurantId: ..., latitude: ..., longitude: ..., coordinates: restaurant.autoLocation.coordinates };

// Work queue — the rider matcher's direct consumer (existing path).
await publishEvent("order:ready_for_rider", readyPayload);

// SNS fanout — the AI dispatch swarm subscribes with its own queue
// (FilterPolicy on the event attribute). The work queue is the
// rider assignment path and already succeeded; losing the fanout
// only degrades dispatch to a later round, so log-and-continue.
const fanned = await publishOrderEvent("order:ready_for_rider", readyPayload);
if (!fanned) {
  console.warn(`Ready-order fanout to dispatch failed (order ${updated.id}) — the swarm will not see this order`);
}
```

**The Flaw:**
Two points of failure for one state transition, in two different messaging systems, ordered so that the *less* critical one is awaited and the *more* critical one is swallowed.

Walking the topology:

- `publishEvent(...)` → `sendWorkItem(ORDER_QUEUE_URL, ...)` → **SQS `OrderQueue`** → `rider-service.orderReadyConsumer` → `listAvailableRidersNear(...)` → `publishFanoutBatch` to riders. This is the *push-to-rider* path.
- `publishOrderEvent(...)` → **SNS `EventsTopic`** → `ai-dispatch.dispatchConsumer` → the LangGraph swarm → `dispatch.decision`. This is the *AI assignment* path.

`publishOrderEvent` is `makeDomainEventPublisher()`, which returns `false` on failure rather than throwing (`messaging.ts:147-153`). The controller logs a `console.warn` and continues. So:

- **SNS throttling, an IAM regression, a 5 s publish timeout, or a transient 5xx** → the swarm never learns the order exists. There is no retry, no DLQ, no replay handle. The only trace is a warn line in a 14-day log group.
- The user-facing symptom is *"my order never got a rider"* while `order:ready_for_rider` was successfully written to SQS — so the rider matcher fires, finds riders, and the swarm (which is the primary assigner per `docs/AI_DISPATCH_DESIGN.md`) never runs.

The comment frames this as an acceptable degradation ("only degrades dispatch to a later round"). There is no "later round" — nothing re-publishes `order:ready_for_rider` to SNS. `dispatch_service._claim` writes a `READY#<orderId>/SEEN` idempotency marker only when the consumer *runs*.

Because this is a dual-write with no transactional boundary, it is exactly the failure mode a transactional outbox exists to prevent, and it is the only place in the platform that writes the same domain fact to two transports.

**The Fix:**
Collapse to **one** write. SNS already has a `FilterPolicy` subscription mechanism, and `rider-service` already consumes SNS directly for compensation events (`rider-service/serverless.yml:152-160`). Make `OrderQueue` an SQS-queue **subscribed to the topic**, not a second publish target:

```yaml
# infra/serverless.yml — the queue becomes a subscriber, not a publish target
OrderQueueSubscription:
  Type: AWS::SNS::Subscription
  Properties:
    TopicArn: !Ref EventsTopic
    Protocol: sqs
    Endpoint: !GetAtt OrderQueue.Arn
    RawMessageDelivery: false          # keep the SNS envelope; handlePushBatch unwraps it
    FilterPolicy:
      event: ["order:ready_for_rider"]
    RedrivePolicy:
      deadLetterTargetArn: !GetAtt OrderQueueDLQ.Arn

OrderQueuePolicy:
  Type: AWS::SQS::QueuePolicy
  Properties:
    Queues: [!Ref OrderQueue]
    PolicyDocument:
      Statement:
        - Effect: Allow
          Principal: { Service: sns.amazonaws.com }
          Action: sqs:SendMessage
          Resource: !GetAtt OrderQueue.Arn
          Condition:
            ArnEquals: { "aws:SourceArn": !Ref EventsTopic }
```

```ts
// order.ts — ONE publish, one failure mode, one retry path
const published = await publishOrderEvent("order:ready_for_rider", readyPayload);
if (!published) {
  // Nothing downstream ran. Fail the request so the seller retries and the
  // state machine does not advance past a transition nobody heard about.
  return res.status(503).json({
    message: "Order saved but the ready-for-rider event could not be published — retry",
    code: "EVENT_PUBLISH_FAILED",
    orderId: updated.id,
  });
}
```

If a 503 on a status change is unacceptable (it is a bad seller experience), use the outbox instead of swallowing: write `OUTBOX#<orderId>/order:ready_for_rider` in the same `TransactWriteItems` as the status update, and let a 1-minute sweeper publish and delete. That is more machinery for a guarantee you can also get by making the publish retryable.

**Trade-offs:**
- One extra hop (SNS → SQS) versus a direct `SendMessage`, ~1 request of cost per order. Trivial, and it buys you SNS's own retry + the DLQ.
- `rider-service`'s `orderReadyConsumer` already speaks `handleSqsBatch`; with `RawMessageDelivery: false` the envelope is SNS-shaped, which `handlePushBatch`/`toSqsShape` already unwraps. But an **SQS** trigger delivers `{Records:[{body: "<sns-envelope>"}]}` — the handler must call `toSqsShape` on the *body*, not on the event. Verify with a test; this is the single most likely place to introduce a silent regression during the migration.
- A 503 on publish failure changes the seller's UX from "silent" to "retryable error". That is correct, but it needs the frontend to show a non-destructive toast and keep the order form populated.

---

## A-05 · `order:track` and `rider:location` have no authorisation at all

**Severity & Impact:** **Critical** — cross-tenant data exposure (live GPS of arbitrary riders) and data *injection* (spoofed GPS into any order room).

**Location:** `backend/realtime-service/src/config/websocket.ts:62-117`

```ts
switch (message.action) {
  case "order:track":
    if (message.orderId) {
      await joinRoom(connectionId, `order:${message.orderId}`);   // ← any orderId
    }
    break;

  case "order:untrack":
    if (message.orderId) {
      await leaveRoom(connectionId, `order:${message.orderId}`);
    }
    break;

  case "rider:location": {
    const { orderId, latitude, longitude } = message;
    if (orderId && typeof latitude === "number" && typeof longitude === "number") {
      await broadcastToRoom(endpoint, `order:${orderId}`, "rider:location", { orderId, latitude, longitude, at: Date.now() });  // ← any room, any sender
    }
    break;
  }
```

**The Flaw:**
Two separate holes:

1. **Subscribe-anything.** `$connect` proves *who* you are (`jwt.verify`) and auto-joins `user:{id}`. But `order:track` accepts an arbitrary client-supplied `orderId` and joins that room with no check that the caller is the order's customer, its restaurant, or its rider. Combined with `rider:location` broadcasts (which carry exact coordinates every 5 s — see `apps/web/src/hooks/use-rider-location-stream.ts`), any authenticated account can enumerate order IDs and stream any rider's live position. Order IDs are UUIDv4 so they are not guessable, but they leak trivially through shared tracking links, screenshots, support tickets, and the assistant's transcript.

2. **Broadcast-anything.** `rider:location` is a *write* into any room keyed by a client-supplied `orderId`, with no verification that the sender is the rider assigned to that order. Any authenticated connection can therefore spoof the rider's position to the customer and to the restaurant. For a delivery product, "the rider is 200 m away" is a trust-bearing signal; making it forgeable by any account is worse than leaking it.

The existing `docs/14-known-gaps.md §1.1` records the *subscribe* half. The *write* half is not recorded anywhere, and it is the more dangerous of the two.

**The Fix:**
Verify membership against `OrdersTable` in `$default`, and derive the rider's identity from the connection, not from the message.

```ts
// realtime-service/src/config/websocket.ts
import { getOrderById } from "@foodo/backend-common/dynamo";
import { getConnectionIdentity } from "./db.js";   // new: connectionId → { userId, role }

const AUTHORISED_ROLES = new Set(["customer", "seller", "rider", "admin"] as const);

/**
 * Who may watch an order room?
 *   - the ordering customer
 *   - the owning restaurant (any of its staff)
 *   - the rider currently assigned
 *   - admin
 * Anyone else gets no room and no error detail (no existence oracle).
 */
async function canObserveOrder(userId: string, role: string, orderId: string): Promise<boolean> {
  if (role === "admin") return true;
  const order = await getOrderById(orderId);
  if (!order) return false;
  if (order.userId === userId) return true;
  if (order.riderId === userId) return true;
  if (role === "seller") {
    const restaurant = await getRestaurantById(order.restaurantId);
    return restaurant?.ownerId === userId;
  }
  return false;
}

case "order:track": {
  const identity = await getConnectionIdentity(connectionId);
  if (!identity) return fail(403, "Unknown connection");
  const orderId = String(message.orderId ?? "");
  if (!orderId) return fail(400, "orderId required");

  if (!(await canObserveOrder(identity.userId, identity.role, orderId))) {
    return fail(403, "Forbidden");            // one status, no distinction
  }
  await joinRoom(connectionId, `order:${orderId}`);
  break;
}

case "rider:location": {
  const identity = await getConnectionIdentity(connectionId);
  if (!identity || identity.role !== "rider") return fail(403, "Forbidden");

  const orderId = String(message.orderId ?? "");
  const { latitude, longitude } = message;
  if (!orderId || typeof latitude !== "number" || typeof longitude !== "number") {
    return fail(400, "orderId, latitude, longitude required");
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return fail(400, "coordinates out of range");
  }

  // The sender must BE the assigned rider — identity comes from the connection.
  const order = await getOrderById(orderId);
  if (!order || order.riderId !== identity.userId) return fail(403, "Forbidden");

  await broadcastToRoom(endpoint, `order:${orderId}`, "rider:location", {
    orderId, latitude, longitude, at: Date.now(),
  });
  break;
}
```

`getConnectionIdentity` is one `GetItem` on `ConnectionsTable` (already the partition key) — or simply carry the identity in the `$connect` row when joining rooms:

```ts
// db.ts — joinRoom already writes a row; persist who owns the connection with it
export async function joinRoom(connectionId: string, room: string, identity?: { userId: string; role: string }) {
  await docClient().send(new PutCommand({
    TableName: CONNECTIONS_TABLE,
    Item: { connectionId, room, ttl: Math.floor(Date.now() / 1000) + 2 * 60 * 60, ...(identity ?? {}) },
  }));
}
```

Put `userId`/`role` on the `user:{userId}` row at `$connect` and read it back with a `Query` on `connectionId`.

**Trade-offs:**
- `$default` now costs 1–3 DynamoDB reads per action instead of 0–1. At realistic WebSocket message volumes (a rider sends 1 location per 5 s = 720/hour) this is a rounding error, but it does move the check into the hot path — consider caching the `order → riderId` mapping per container for 30 s if the volume ever justifies it.
- A 403 on `order:track` will break the existing tracking page **for the restaurant owner** until `getRestaurantById` is available in the realtime service (it is not in its IAM today — `realtime-service/serverless.yml:61-72` grants only `ConnectionsTable`). You must add a narrowly scoped read on `RestaurantsTable` (`dynamodb:GetItem` on the table ARN only).
- Rejecting with a bare `403` removes the "does this order exist?" oracle but also makes client debugging harder. Log the reason server-side, keyed by `requestId`.

---

## A-06 · Secret fallbacks fail open in six stacks, and `INTERNAL_SERVICE_KEY` fails open in five

**Severity & Impact:** **Critical** — one forgotten env var silently deploys an insecure stack.

**Location:**

| Stack | Offending line |
|---|---|
| `core/serverless.yml:40` | `JWT_SECRET: ${env:JWT_SECRET, 'dev-only-change-me'}` |
| `backend/restaurant-service/serverless.yml:47-48` | same for `JWT_SECRET`, `COOKIE_SECRET` |
| `backend/rider-service/serverless.yml:45-46` | same |
| `backend/realtime-service/serverless.yml:49-50` | same |
| `backend/admin-service/serverless.yml` | same |
| `backend/utils-service/serverless.yml:41-42` | same |
| `backend/utils-service/serverless.yml:43-47` | `RAZORPAY_*` / `STRIPE_*` → `''` |
| `backend/utils-service/serverless.yml:58` | `INTERNAL_SERVICE_KEY: ${env:INTERNAL_SERVICE_KEY, ''}` |
| `backend/rider-service/serverless.yml:50` | `INTERNAL_SERVICE_KEY: ${env:INTERNAL_SERVICE_KEY, ''}` |
| `backend/ai-verification/serverless.yml` | `INTERNAL_SERVICE_KEY` → `''` |
| `backend/ai-menu-parser/serverless.yml`, `backend/ai-commerce/serverless.yml` | `INTERNAL_SERVICE_KEY` → `''` |

Contrast with the stacks that get it right:

```yaml
# backend/restaurant-service/serverless.yml:49-53 — the correct pattern, already written
# Same secret as every sibling stack. The old `dev-only-change-me`
# fallback was a published value on a money path (it gates the
# payment claim) and guaranteed a 403 mismatch with any service that
# used the real key, so the value is now required, not defaulted.
INTERNAL_SERVICE_KEY: ${env:INTERNAL_SERVICE_KEY}
```

```yaml
# backend/ai-dispatch/serverless.yml:109-112 — the other correct pattern
# No fallback, on purpose: pycommon's settings validate at import and
# raise without a key, so an empty value deploys a stack whose every
# route (health included) 500s. Fail at deploy, not on first request.
INTERNAL_SERVICE_KEY: ${env:INTERNAL_SERVICE_KEY}
```

**The Flaw:**
Someone already fixed two stacks and wrote a comment explaining exactly why. Five more still fail open, and the fix was never propagated.

- `'dev-only-change-me'` as `JWT_SECRET` is a **published signing key**. Any deployment where the env var is missing (a new stage, a CI runner without the secret store, a developer's first `sls deploy`) issues tokens anyone can forge. Worse, `core/authorizer.ts` verifies with the same secret, so forged tokens pass the gateway and are only rejected by whichever service happens to have the real key — producing a partial-auth state that is very hard to reason about.
- `INTERNAL_SERVICE_KEY: ''` interacts catastrophically with `isInternal`:

```ts
// packages/backend-common/src/middlewares/isInternal.ts:19-31
const expected = process.env.INTERNAL_SERVICE_KEY ?? "";
if (typeof provided !== "string" || expected.length === 0 || ...) {
```

`expected.length === 0` correctly rejects. **But `restaurant-service` and `ai-verification` don't use `isInternal`** — they compare inline:

```ts
// restaurant-service/src/controllers/order.ts:628
if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
  throw new Error("Forbidden");
}
```

If `INTERNAL_SERVICE_KEY` is `''` and the header is absent, `req.headers["x-internal-key"]` is `undefined`, and `undefined !== ''` is `true` → throws. That direction is safe. But an attacker who sends `x-internal-key: ` (empty string, which some HTTP clients normalise to `''` or drop) — behaviour differs by proxy. And on the *publish* side, an empty key means `utils-service` calling `restaurant-service` sends `x-internal-key: ''`, which either 500s (this code) or passes (any `isInternal` variant that used `??  ""` comparison without the `.length === 0` guard — e.g. a future copy). The system's behaviour on a misconfigured deploy is undefined rather than fail-closed.

- `RAZORPAY_KEY_ID: ''` on the **money path**: `new Razorpay({ key_id: '' })` constructs successfully; the failure surfaces as a runtime 401 from Razorpay inside `runProvider`, which the breaker interprets as a provider outage. A deploy-time typo becomes a mid-checkout outage.

**The Fix:**
Remove every fallback. Serverless Framework resolves `${env:X}` to an empty string if unset and warns — so additionally add an explicit assertion. The cleanest place is a custom plugin, because it runs at package time and blocks the deploy:

```js
// scripts/serverless-require-secrets.js
const REQUIRED = {
  "foodo-core-api":        ["JWT_SECRET"],
  "foodo-auth":            ["JWT_SECRET", "COOKIE_SECRET"],
  "foodo-restaurant":      ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-rider":           ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-realtime":        ["JWT_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-admin":           ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-utils":           ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY",
                            "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
  "foodo-ai-verification": ["INTERNAL_SERVICE_KEY"],
  "foodo-ai-orchestrator": ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-ai-commerce":     ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-ai-menu-parser":  ["JWT_SECRET", "COOKIE_SECRET", "INTERNAL_SERVICE_KEY"],
  "foodo-ai-dispatch":     ["INTERNAL_SERVICE_KEY"],
};

class RequireSecrets {
  constructor(serverless) {
    this.hooks = {
      "before:package:initialize": () => {
        const needed = REQUIRED[serverless.service.service] ?? [];
        const missing = needed.filter((k) => !process.env[k] || process.env[k].trim() === "");
        if (missing.length) {
          throw new serverless.classes.Error(
            `${serverless.service.service}: refusing to deploy — missing required env: ${missing.join(", ")}`,
          );
        }
        if (process.env.JWT_SECRET === "dev-only-change-me") {
          throw new serverless.classes.Error("JWT_SECRET is the published dev value — refusing to deploy");
        }
      },
    };
  }
}
module.exports = RequireSecrets;
```

Register it in each `serverless.yml`:

```yaml
plugins:
  - ../../scripts/serverless-require-secrets.js
```

And strip every fallback:

```yaml
# before
JWT_SECRET: ${env:JWT_SECRET, 'dev-only-change-me'}
# after
JWT_SECRET: ${env:JWT_SECRET}
```

**Trade-offs:**
- Local `sls offline` / ad-hoc deploys now need a `.env` with real values. That is the point, but it will frustrate contributors until `.env.example` is complete — make sure it lists every key (it mostly does).
- A plugin that throws in `before:package` breaks `sls package` in CI without secrets. If CI only packages (not deploys), gate the assertion on `!process.env.CI_PACKAGE_ONLY`.
- The long-term answer is SSM Parameter Store / Secrets Manager with `${ssm:/foodo/${opt:stage}/jwt-secret~true}`, which removes secrets from developer shells entirely. That is a larger migration; the plugin buys you the safety now.

---

## A-07 · The gateway authorizer accepts any JWT signed with the shared secret — including the "socket token"

**Severity & Impact:** **Critical** — a narrowly-scoped credential is silently a full-scope credential, and the strictness the auth service implements is bypassed for every other service.

**Location:**
- `core/src/authorizer.ts:61-86`
- `backend/auth-service/src/middlewares/isAuth.ts:32-47`
- `backend/auth-service/src/controllers/socket-token.ts:13-22`

```ts
// core/src/authorizer.ts — the ONLY check is signature + sub
const claims = jwt.verify(token, process.env.JWT_SECRET!) as { sub?: string; role?: string };
if (!claims?.sub) return { isAuthorized: false };
return { isAuthorized: true, context: { sub: String(claims.sub), ...(claims.role !== undefined ? { role: String(claims.role) } : {}) } };
```

```ts
// auth-service/src/middlewares/isAuth.ts — deliberately STRICTER
// JWT signature + expiry are verified at the API Gateway ... this middleware
// DECODEs the session JWT and only enforces the strict claims contract
// (typ === "access", sub present).
if (!decode || decode.typ !== "access" || !decode.sub) {
  return res.status(401).json({ message: "Unauthorized" });
}
```

```ts
// socket-token.ts
token: signAccessToken(claims.sub, claims.role),   // identical shape to a real access token
```

**The Flaw:**
`signAccessToken` produces `{ role, typ: "access", sub, iat, exp }`. The socket-token endpoint reuses it verbatim. Therefore:

- The "socket bootstrap token" (`socket-token.ts`) — intended only for the cross-origin WebSocket handshake, delivered into browser memory, and documented as a *minimal* credential — is **byte-for-byte the same class of credential as a session access token**. It works as `Authorization: Bearer` against every protected route on the gateway: `/api/order/*`, `/api/address/*`, `/api/rider/*`, `/api/admin/*`.
- The strict `typ === "access"` check that `auth-service` spent a comment block justifying **never runs for any other service**, because the gateway authorizer has already authorised the request and `backend-common`'s `isAuth` only *decodes*:

```ts
// packages/backend-common/src/middlewares/isAuth.ts:71-101
const fromGateway = gatewayClaims(req);
if (fromGateway) { req.user = { ...fromGateway }; return next(); }   // ← typ never checked
```

- The authorizer also has no `aud`, no `iss`, and no clock-skew tolerance configuration. Any token signed with `JWT_SECRET` — including one minted by a compromised low-privilege service, or the `'dev-only-change-me'` default from A-06 — passes.

This is a privilege-scope inversion: the system has two token classes and treats them as one.

**The Fix:**
Give socket tokens their own claim and verify it at the gateway. Minimal, non-breaking version:

```ts
// auth-service/src/lib/tokens.ts
export const ACCESS_TTL_SEC = 15 * 60;
const SOCKET_TTL_SEC = 60;              // must only survive the handshake + reconnect

export function signAccessToken(sub: string, role: string): string {
  return jwt.sign({ role, typ: "access" }, process.env.JWT_SECRET!, { subject: sub, expiresIn: ACCESS_TTL_SEC });
}

/** Handshake-only credential. Cannot be used as a session token. */
export function signSocketToken(sub: string, role: string): string {
  return jwt.sign({ role, typ: "socket" }, process.env.JWT_SECRET!, { subject: sub, expiresIn: SOCKET_TTL_SEC });
}
```

```ts
// core/src/authorizer.ts — reject everything that is not an access token
const claims = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ["HS256"] }) as {
  sub?: string; role?: string; typ?: string;
};

// `typ` is mandatory. Tokens minted before this change carry typ:"access"
// already (see tokens.ts), so no legacy-token break is introduced.
if (claims?.typ !== "access" || !claims.sub) return { isAuthorized: false };
```

```ts
// realtime-service/src/config/websocket.ts — the handshake is where "socket" is legal
const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET!, { algorithms: ["HS256"] }) as any;
if (decoded?.typ !== "socket") return fail(401, "Invalid token type");
```

**Trade-offs:**
- A 60-second socket token means the client must re-mint on every reconnect, not just at mount. That is a *good* change (see B-13) — but it makes the token-fetch an active part of the reconnect loop, so the two fixes must land together.
- If any deployed mobile client is caching a socket token beyond 60 s today, it will start getting 401s. Roll out the TTL reduction after the client's re-mint-on-reconnect logic ships (B-13), or start at 15 min and tighten later.
- Tokens issued before this change already carry `typ: "access"` (see `signAccessToken`), so the gateway change is backward-compatible. Verify with a decode of a live cookie before deploying.

---

# Part B — High

## B-01 · Zero concurrency controls on any function; the AI dispatch consumer is unbounded

**Severity & Impact:** **High** — a single burst can exhaust DynamoDB, the LLM provider quota, and your Lambda account concurrency at once, taking down checkout with it.

**Location:** every `serverless.yml` in the repo. Representative: `backend/ai-dispatch/serverless.yml:177-195`

```yaml
dispatchConsumer:
  handler: app/handlers/dispatchConsumer.handler
  memorySize: 1024
  timeout: 180               # LLM nodes + enrichment per record
  events:
    - sns:
        arn: ${cf:${self:custom.infra}.EventsTopicArn}
        filterPolicy:
          event:
            - order:ready_for_rider
```

**The Flaw:**
There is no `reservedConcurrency`, no `maximumConcurrency` (the SQS event-source knob), and no account-level guardrail anywhere in the 13 stacks. Grep for `reservedConcurrency` across all `serverless.yml` files: zero hits.

Each `order:ready_for_rider` event invokes **one** `dispatchConsumer` with a **180 s** timeout at **1024 MB**. The handler runs a LangGraph swarm (`ai-dispatch/app/services/dispatch_service.py`) that does DynamoDB reads, external LLM calls, and an SNS publish. During a Friday-dinner burst a single restaurant going `ready_for_rider` on 40 orders produces 40 concurrent 1024 MB Lambdas each holding an LLM connection for up to 3 minutes.

Three separate ceilings break, in this order:

1. **Account concurrency.** Every Lambda in the account shares 1,000 concurrent executions (default). 300 dispatch consumers at 1024 MB consume 300,000 MB-seconds and, critically, 300 concurrency slots — starving `restaurant-service.http` (which serves checkout) of slots. Lambda throttles the *checkout* Lambdas, not the AI ones.
2. **LLM provider quota.** `pycommon/llm.py` and `ai-verification/config/ai.ts` both wrap a single provider. 300 simultaneous vision/reasoning calls trips the provider's rate limit; the in-process breaker (`pycommon/resilience.py`, `opossum` in TS) is **per container**, so 300 containers each independently decide "the provider is fine" and 300 requests get 429'd.
3. **DynamoDB.** `dispatch_service._pop_pool_candidates` queries `DISPATCH_STATE_TABLE` with a `FilterExpression` and `Limit: 400`; `DispatchStateTable` is `PAY_PER_REQUEST`, so there is no reserved capacity to throttle against — it absorbs the burst and throttles *other* tables sharing the same account limit.

The same absence applies to `paymentConsumer` (batchSize 5, timeout 30), `orderReadyConsumer` (batchSize 5, timeout 30), and `realtime.eventConsumer` (which fires **per event** with no filter — see B-06).

**The Fix:**
Set a hard cap on the AI tier and a protected floor for the money tier. `serverless.yml` supports `maximumConcurrency` for SQS and `reservedConcurrency` for any function:

```yaml
# backend/ai-dispatch/serverless.yml
dispatchConsumer:
  handler: app/handlers/dispatchConsumer.handler
  memorySize: 1024
  timeout: 180
  # Hard ceiling: the swarm must never be able to starve checkout of
  # account concurrency, and it must never blow past the LLM quota.
  # 50 × 180 s ≈ 2.5 orders/s sustained — above observed peak.
  reservedConcurrency: 50
  events:
    - sns:
        arn: ${cf:${self:custom.infra}.EventsTopicArn}
        filterPolicy:
          event: [order:ready_for_rider]
        redrivePolicy:
          deadLetterTargetRef: DispatchOrdersQueueDLQ
```

```yaml
# backend/realtime-service/serverless.yml — the per-event consumer needs the tightest cap
eventConsumer:
  handler: dist/eventConsumer.handler
  reservedConcurrency: 100
```

```yaml
# backend/restaurant-service/serverless.yml — protect checkout explicitly
http:
  handler: dist/http.handler
  timeout: 30
  reservedConcurrency: 200      # a floor nothing else can take
paymentConsumer:
  handler: dist/paymentConsumer.handler
  timeout: 30
  reservedConcurrency: 20       # money path must always have capacity
```

> **Ordering matters:** `reservedConcurrency` on the AI tier *reserves* capacity, which means the account limit must be raised first. Request a concurrency limit increase to 3,000 before deploying these numbers, or the deploy will succeed and then throttle everything.

Add the account-level guardrail too — a CloudWatch composite alarm is the only thing that will page you:

```yaml
# infra/serverless.yml — resources.Resources
LambdaConcurrencyAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${sls:stage}-lambda-concurrency-high
    AlarmDescription: Account concurrency above 80% — checkouts will start throttling
    Namespace: AWS/Lambda
    MetricName: ConcurrentExecutions
    Statistic: Maximum
    Period: 60
    EvaluationPeriods: 3
    Threshold: 800
    ComparisonOperator: GreaterThanThreshold
```

**Trade-offs:**
- `reservedConcurrency` **reserves** the capacity permanently; you pay for availability, not usage. 50 + 100 + 200 + 20 = 370 slots reserved whether or not traffic exists. On a small account that is a real cost.
- A capped `dispatchConsumer` will make SNS retry (and eventually DLQ) events during an extreme burst. That is the correct behaviour — bounded degradation instead of a platform-wide stall — but it needs the DLQ to be monitored (see D-05).
- `reservedConcurrency: 50` is a guess. Instrument `ConcurrentExecutions` per function for a week before picking the number, or start at `-1` (unreserved) with only the *alarm* and tighten afterwards.

---

## B-02 · `handleSqsBatch` fans the whole batch out with `Promise.all`

**Severity & Impact:** **High** — unbounded in-container parallelism; the pattern does not survive a batch-size increase.

**Location:** `packages/backend-common/src/aws/messaging.ts:227-253`

```ts
export async function handleSqsBatch<T = any>(event: SqsBatchEvent, onMessage: (data: T, raw: { body: string }) => Promise<void>): Promise<SqsBatchResult> {
  const failures: string[] = [];

  await Promise.all(
    (event.Records ?? []).map(async (record, index) => {
      try {
        const parsed = JSON.parse(record.body);
        const data = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
        await onMessage(data as T, record);
      } catch (error) {
        failures.push(String(record.messageId ?? index));
      }
    }),
  );

  return { batchItemFailures: failures.map((id) => ({ itemIdentifier: id })) };
}
```

**The Flaw:**
`Promise.all` over every record means the whole batch is processed concurrently. Today `batchSize: 5` in three places, so the blast radius is 5-wide — but the primitive is the shared contract for *every* consumer, and `onMessage` is not a free function: `onPaymentSuccess` does `markOrderPaid` + `stampProviderPaymentId` + `clearCart` + three realtime publishes; `orderReadyHandler` does a `listAvailableRidersNear` query plus a `PublishBatch`. A `batchSize` bump to 10 (the SQS max for a Lambda trigger) doubles concurrency instantly, with no code change and nobody noticing.

Also note the inconsistency: the Python twin is **sequential**.

```python
# packages/pycommon/pycommon/aws.py — handle_sqs_batch
def handle_sqs_batch(event, on_message):
    failures = []
    for record in event.get("Records", []):   # ← serial
        ...
```

Two services consume the same conceptual queue type with opposite concurrency semantics. Any load-model based on one is wrong for the other.

**The Fix:**
Bound it explicitly. A tiny p-limit-style helper keeps the primitive dependency-free:

```ts
// packages/backend-common/src/aws/concurrency.ts
/** Run `worker` over `items` with at most `limit` in flight. Preserves order of results. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error("limit must be >= 1");
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
```

```ts
// messaging.ts
export interface SqsBatchOptions {
  /** Max records processed concurrently inside one invocation. Default 4. */
  concurrency?: number;
}

export async function handleSqsBatch<T = any>(
  event: SqsBatchEvent,
  onMessage: (data: T, raw: { body: string }) => Promise<void>,
  options: SqsBatchOptions = {},
): Promise<SqsBatchResult> {
  const limit = Math.max(1, options.concurrency ?? 4);
  const failures: string[] = [];

  await mapWithConcurrency(event.Records ?? [], limit, async (record, index) => {
    try {
      const parsed = JSON.parse(record.body);
      const data = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
      await onMessage(data as T, record);
    } catch (error) {
      console.error(`[SQS] message ${record.messageId ?? index} failed:`, error instanceof Error ? error.message : error);
      failures.push(String(record.messageId ?? index));
    }
  });

  return { batchItemFailures: failures.map((id) => ({ itemIdentifier: id })) };
}
```

**Trade-offs:**
- Lower intra-invocation concurrency means a 5-record batch takes up to 2× longer if each record is slow. That is exactly what you want (bounded latency instead of bounded throughput) but it must be measured against `SQS` `VisibilityTimeout` — still 6× the function timeout, so there is headroom.
- The default of `4` is arbitrary. Choose it from the slowest downstream: `onPaymentSuccess` does ~8 DynamoDB ops, so 4 concurrent × 8 = 32 concurrent writes per invocation — well within a single partition's 1,000 WCU.
- Bounding concurrency does **not** bound cross-invocation concurrency. B-01's `reservedConcurrency` is still required.

---

## B-03 · `setOrderStatus` permits any status transition

**Severity & Impact:** **High** — the order state machine is unenforced; regressions produce wrong customer-facing states and corrupt analytics.

**Location:** `packages/backend-common/src/dynamo/Order.ts:569-589`

```ts
export async function setOrderStatus(orderId: string, status: OrderStatus): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression: "SET #s = :status, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND paymentStatus = :paid",   // ← only "paid"
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":status": status, ":paid": "paid", ":now": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}
```

**The Flaw:**
The guard is `paymentStatus = "paid"`. It says nothing about the *current* status. So `PUT /api/order/:orderId { status: "preparing" }` succeeds on a `delivered` order, on a `cancelled` order, and on a `picked_up` order.

The consequences are not cosmetic:

- **Analytics corruption.** `getRestaurantAnalytics` (`order.ts:349`) rolls up `listOrdersByRestaurant(restaurantId, { limit: 500 })` in memory and groups by `status`. A `delivered → preparing` regression moves revenue out of the completed bucket silently.
- **Saga breakage.** `rider-service.acceptOrder` claims a rider only when the order is `ready_for_rider` (`assignRider` guards on `#s = :ready`), but a seller can move `ready_for_rider → preparing` after assignment. Now the order has a rider and is in the kitchen: the rider will `transitionRiderStatus`, which requires `rider_assigned`, and gets `null` — a silent no-op.

```ts
// Order.ts:596-609 — transitionRiderStatus silently no-ops on an illegal from-state
const next = current.status === "rider_assigned" ? "picked_up"
           : current.status === "picked_up"      ? "delivered"
           : null;
if (!next) return null;      // ← rider taps "picked up", nothing happens, no error
```

Note the asymmetry: the rider transitions are guarded (`ConditionExpression: "#s = :expected"`), the seller transitions are not. The state machine exists — it just has a hole in the seller door.

**The Fix:**
Make the transition table explicit and shared, and guard the write with it.

```ts
// packages/backend-common/src/dynamo/orderTransitions.ts
export type OrderStatus =
  | "placed" | "preparing" | "ready_for_rider" | "rider_assigned"
  | "picked_up" | "delivered" | "cancelled";

/**
 * The order state machine. Single source of truth for both the seller-facing
 * PUT /api/order/:id and the rider-facing transition endpoint.
 * `cancelled` is terminal. `delivered` is terminal.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  placed:          ["preparing", "cancelled"],
  preparing:       ["ready_for_rider", "cancelled"],
  ready_for_rider: ["rider_assigned", "preparing", "cancelled"],  // back to kitchen is legal
  rider_assigned:  ["picked_up", "ready_for_rider", "cancelled"], // rider dropped → re-queue
  picked_up:       ["delivered"],
  delivered:       [],
  cancelled:       [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}
```

```ts
// Order.ts
export type SetStatusResult =
  | { ok: true; order: DynamoOrder }
  | { ok: false; reason: "NOT_FOUND" | "NOT_PAID" | "ILLEGAL_TRANSITION"; from?: OrderStatus };

export async function setOrderStatus(orderId: string, status: OrderStatus): Promise<SetStatusResult> {
  const current = await getOrderById(orderId);
  if (!current) return { ok: false, reason: "NOT_FOUND" };

  // Fast, readable rejection BEFORE the write, so the caller gets a real 409.
  if (!canTransition(current.status as OrderStatus, status)) {
    return { ok: false, reason: "ILLEGAL_TRANSITION", from: current.status as OrderStatus };
  }

  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression: "SET #s = :status, updatedAt = :now",
        // The guard is on the FROM state, so an interleaved writer cannot
        // slip a second transition between the read and the write.
        ConditionExpression: "attribute_exists(pk) AND paymentStatus = :paid AND #s = :from",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": status, ":from": current.status, ":paid": "paid", ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      }),
    );
    return { ok: true, order: out.Attributes as DynamoOrder };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { ok: false, reason: "ILLEGAL_TRANSITION", from: current.status as OrderStatus };
    }
    throw err;   // do NOT swallow throttling
  }
}
```

Caller:

```ts
// restaurant-service/src/controllers/order.ts — updateOrderStatus
const result = await setOrderStatus(orderId, status as OrderStatus);
if (!result.ok) {
  const code = result.reason === "ILLEGAL_TRANSITION" ? 409 : result.reason === "NOT_FOUND" ? 404 : 402;
  return res.status(code).json({ message: `Cannot move order to ${status}`, code: result.reason });
}
```

**Trade-offs:**
- One extra `GetItem` per status change. Order status changes are low-frequency (a handful per order), so this is negligible against the correctness win.
- The read-then-write is still two round-trips, but the `ConditionExpression` on `#s = :from` closes the race — a concurrent writer invalidates the second one, which returns a clean 409.
- **Legacy data risk.** Existing orders in odd states (`delivered` orders stamped while the hole existed) may fail the first transition under the new table. Ship the table with a monitoring window that *logs* illegal transitions but still permits them, then flip to enforcing after a week.

---

## B-04 · Blanket `catch(() => null)` makes infrastructure errors look like business no-ops

**Severity & Impact:** **High** — throttling, network partitions, and validation errors are reported to callers as "nothing to do", so callers proceed with wrong assumptions.

**Location:** four sites, all the same defect.

```ts
// packages/backend-common/src/dynamo/Order.ts:641-661 — markOrderPaid
).catch(() => null); // already paid → no-op (webhook redeliveries)
```

```ts
// Order.ts:400-422 — attachRefund
.catch(() => null);
```

```ts
// restaurant-service/src/dynamo/cart.ts:284-302 — toggleMenuItemAvailabilityTo
).catch(() => null);
```

```ts
// cart.ts:107-127 — decrementCartItem
.catch(() => null); // quantity == 1 → caller decides to delete
```

**The Flaw:**
The comment `// already paid → no-op (webhook redeliveries)` describes the *intended* case: `ConditionalCheckFailedException`. What the code actually catches is *everything*:

- `ProvisionedThroughputExceededException` / `ThrottlingException`
- `RequestTimeout` / `NetworkingError`
- `ValidationException` (a malformed item, a number typed as string)
- `ResourceNotFoundException` (an IAM or table-name regression)

All of them collapse to `null`, which every caller reads as "the business condition wasn't met".

Concrete failure on the money path:

```ts
// restaurant-service/src/config/consumers.ts — onPaymentSuccess
const paid = await markOrderPaid(orderId);
// `null` is interpreted as "already paid" — which is TRUE for a throttle.
// The consumer then acks the SQS message, and the order is never marked paid.
```

The customer paid, the webhook was verified, the message was consumed and deleted, and the order stays `paymentStatus: "pending"` forever. The only record is that the money moved. Reconciliation (`utils-service/src/config/reconciliation.ts`) queries the `payment-status` GSI for `pending` orders older than 20 minutes — so it *will* eventually catch this, but only up to `Limit: 100` per hour (B-08), and only if the gateway transaction is still queryable.

**The Fix:**
Narrow every catch to the one exception that means "business no-op", and let the rest propagate so the Lambda retries / the message redrives.

```ts
// packages/backend-common/src/dynamo/errors.ts
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export function isConditionalFailure(err: unknown): boolean {
  return (
    err instanceof ConditionalCheckFailedException ||
    (err as { name?: string })?.name === "ConditionalCheckFailedException"
  );
}
```

```ts
// Order.ts — markOrderPaid
export async function markOrderPaid(orderId: string): Promise<{ paid: DynamoOrder } | { alreadyPaid: true }> {
  try {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression: "SET paymentStatus = :paid, #s = :placed, updatedAt = :now REMOVE expiresAt, ttl",
        ConditionExpression: "paymentStatus <> :paid",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":paid": "paid", ":placed": "placed", ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      }),
    );
    return { paid: out.Attributes as DynamoOrder };
  } catch (err) {
    if (isConditionalFailure(err)) return { alreadyPaid: true };
    throw err;   // throttle / timeout / validation → let SQS retry the message
  }
}
```

Consumer:

```ts
const outcome = await markOrderPaid(orderId);
if ("alreadyPaid" in outcome) {
  console.log(`[payment] ${orderId} already paid — redelivery, acking`);
  return;
}
// ...proceed
```

Same treatment for `attachRefund` (superseded by A-01's `attachRefundCapped`), `decrementCartItem` (a `quantity > 1` failure is genuinely a business outcome; a throttle is not), and `toggleMenuItemAvailabilityTo`.

**Trade-offs:**
- Throwing changes the retry behaviour: a throttled `markOrderPaid` now retries the whole SQS batch item up to `maxReceiveCount: 3`, then DLQs. That is what you want, but it means DLQ depth becomes load-sensitive — alarm on it (D-05).
- Callers must handle a wider result type (`{paid} | {alreadyPaid}`), which touches every call site. It is a mechanical refactor with high payoff.
- `ConditionalCheckFailedException` is thrown both for "already paid" and for "order doesn't exist". Distinguish by re-reading only in the failure path if the caller needs to tell 404 from 200.

---

## B-05 · `claimOrderForPayment` retries with an *unguarded* second write

**Severity & Impact:** **High** — a throttled claim can resurrect a cancelled order or re-open a paid one.

**Location:** `packages/backend-common/src/dynamo/Order.ts:757-800`

```ts
export async function claimOrderForPayment(orderId: string, provider: "razorpay" | "stripe") {
  let out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression: "SET paymentIntent = if_not_exists(paymentIntent, :initIntent), updatedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND paymentStatus <> :paid AND #s <> :cancelled",
      ...
    }),
  ).catch(async (err) => {
    // If paymentIntent already exists and provider needs to update
    return await docClient().send(
      new UpdateCommand({
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression: "SET paymentIntent = ...",
        // ← and the guard is gone
      }),
    );
  });
```

**The Flaw:**
The `.catch` runs the fallback on **any** error, not just `ConditionalCheckFailedException`. Two distinct bugs:

1. **The fallback has no `ConditionExpression` at all.** So when the *guard* is what failed (the order is `cancelled` or already `paid`), the retry writes `paymentIntent` anyway. A payment intent can be attached to a cancelled order — and `utils-service/payment.ts` then creates a real Razorpay/Stripe order against it. The customer can be charged for an order that no longer exists.

2. **Transient errors trigger a second write.** A `ProvisionedThroughputExceededException` on the first call triggers the unguarded second call, which may succeed and *lose the guard entirely* — the exact opposite of a retry's intent.

This is the single most dangerous `.catch()` in the repo: it sits between checkout and the payment gateway.

**The Fix:**
Retry only the conditional failure, and keep the guard in the fallback.

```ts
export type ClaimResult =
  | { ok: true; order: DynamoOrder; attachedProviderOrderId: string | null }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_PAID" | "CANCELLED" };

export async function claimOrderForPayment(orderId: string, provider: "razorpay" | "stripe"): Promise<ClaimResult> {
  const now = new Date().toISOString();

  const base = {
    TableName: TABLE.orders(),
    Key: { pk: orderPk(orderId), sk: ORDER_SK },
    ReturnValues: "ALL_NEW" as const,
  };

  try {
    // Attempt 1 — create the intent if absent.
    const out = await docClient().send(
      new UpdateCommand({
        ...base,
        UpdateExpression: "SET paymentIntent = if_not_exists(paymentIntent, :initIntent), updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND paymentStatus <> :paid AND #s <> :cancelled",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":initIntent": { provider, initiatedAt: now },
          ":now": now, ":paid": "paid", ":cancelled": "cancelled",
        },
      }),
    );
    const order = out.Attributes as DynamoOrder;
    return { ok: true, order, attachedProviderOrderId: order.paymentIntent?.providerOrderId ?? null };
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;   // throttle / timeout → let the caller 503 and retry

    // Attempt 2 — intent already exists. Re-assert the SAME guard; only the
    // provider field may change. A cancelled/paid order still rejects here.
    try {
      const out = await docClient().send(
        new UpdateCommand({
          ...base,
          UpdateExpression: "SET paymentIntent.provider = :provider, paymentIntent.initiatedAt = :now, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk) AND paymentStatus <> :paid AND #s <> :cancelled",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":provider": provider, ":now": now, ":paid": "paid", ":cancelled": "cancelled" },
        }),
      );
      const order = out.Attributes as DynamoOrder;
      return { ok: true, order, attachedProviderOrderId: order.paymentIntent?.providerOrderId ?? null };
    } catch (err2) {
      if (!isConditionalFailure(err2)) throw err2;
      const current = await getOrderById(orderId);
      if (!current) return { ok: false, reason: "NOT_FOUND" };
      if (current.paymentStatus === "paid") return { ok: false, reason: "ALREADY_PAID" };
      return { ok: false, reason: "CANCELLED" };
    }
  }
}
```

**Trade-offs:**
- One extra read on the rejection path (to classify the 409). Cheap and rare.
- Callers must handle the discriminated union. `utils-service/payment.ts` currently assumes a non-null result and calls `toPaymentFacts(order)` — it must now return 409 with the specific `reason`, which the frontend can render as "this order was cancelled" instead of a generic failure.
- `paymentIntent.provider = :provider` uses a nested SET, which fails if `paymentIntent` is not a map. It always is here (set at order creation or by attempt 1), but the first write on a legacy order should be verified in a test.

---

## B-06 · The realtime subscriber has no filter policy — every event, every time

**Severity & Impact:** **High** — invocation volume scales with *total* event volume rather than *broadcast* volume; a direct cost and concurrency multiplier.

**Location:** `backend/realtime-service/serverless.yml:191-205`

```yaml
eventConsumer:
  handler: dist/eventConsumer.handler
  events:
    - sns:
        arn: ${cf:${self:custom.infra}.EventsTopicArn}
        # no filterPolicy — realtime consumes every event, as before
        redrivePolicy:
          deadLetterTargetRef: RealtimeEventsDLQ
```

**The Flaw:**
Every other subscriber filters:

```yaml
# ai-dispatch — filtered
filterPolicy: { event: [order:ready_for_rider] }
# rider-service — filtered
filterPolicy: { event: [rider.order_rejected, order.cancelled, order.delivered] }
# restaurant-service — filtered
filterPolicy: { event: [rider.order_accepted, rider.order_status_changed, payment.intent.created] }
```

`realtime-service` subscribes to the whole topic. Every `dispatch.decision`, `refund.completed`, `refund.blocked`, `verification.packing`, `verification.delivery`, `agent.case.*`, and `payment.intent.created` fires a 256 MB Lambda (the provider-level default at `realtime-service/serverless.yml:43`) that finds no room to broadcast to and exits immediately.

The `# no filterPolicy — realtime consumes every event, as before` comment betrays the reasoning: it preserves parity with a RabbitMQ binding rather than reasoning about the SNS topology. On SNS, the subscription filter is free and exact; on RabbitMQ a fanout exchange required a binding per queue.

Volume estimate: an order emits roughly 8–12 domain events across its life (`payment.intent.created`, `order:ready_for_rider`, `rider.order_accepted`, `rider.order_status_changed` ×3, `verification.packing`, `verification.delivery`, `order.delivered`, `dispatch.decision`). Of those, only the broadcast-shaped ones (`order:update`, `order:new`, `rider:location`) actually target a room. So ~85% of these invocations are no-ops that still bill a request and still consume concurrency.

**The Fix:**
Filter on the attribute the broadcaster actually reads. The envelope is `{ event, room, payload }` with a single `event` message attribute (`messaging.ts:52-54`), so a filter must enumerate broadcast events — or, better, add a second attribute that marks the message as broadcast-shaped:

```ts
// packages/backend-common/src/aws/messaging.ts — add the discriminator
export function makeFanoutPublisher() {
  return async (event: string, room: string, payload: unknown): Promise<void> => {
    try {
      await getSns().send(new PublishCommand({
        TopicArn: topicArn(),
        Message: JSON.stringify({ event, room, payload }),
        MessageAttributes: {
          event: { DataType: "String", StringValue: event },
          // Only fanout messages carry a room. Domain events set "no".
          broadcast: { DataType: "String", StringValue: "yes" },
        },
      }));
    } catch (error) { /* unchanged */ }
  };
}
```

```ts
// makeDomainEventPublisher — the counterpart
MessageAttributes: {
  event: { DataType: "String", StringValue: event },
  broadcast: { DataType: "String", StringValue: "no" },
},
```

```yaml
# realtime-service/serverless.yml
- sns:
    arn: ${cf:${self:custom.infra}.EventsTopicArn}
    filterPolicy:
      broadcast: ["yes"]
    filterPolicyScope: MessageAttributes
    redrivePolicy:
      deadLetterTargetRef: RealtimeEventsDLQ
```

**Trade-offs:**
- **A message with no `broadcast` attribute is silently dropped by the filter.** During the rollout window, in-flight producers are still publishing the old shape — deploy producers first, verify `NumberOfMessagesPublished` vs `NumberOfNotificationsDelivered`, then deploy the consumer filter. A missed broadcast is a stale UI, not data loss, so the blast radius is acceptable; still, sequence it.
- Adding an attribute to every publish is ~0 cost but it must be added in **both** `makeFanoutPublisher` and `makeDomainEventPublisher`, and in `pycommon.publish_realtime_event` / `publish_domain_event` (`pycommon/aws.py`) — four sites, two languages. Miss one and you get a silent partition.
- Alternatively, keep the enumeration approach (`filterPolicy: { event: [...] }`) which needs no producer change but breaks every time a new broadcast event is added. The attribute is more robust; the enumeration is safer to ship today.

---

## B-07 · Every retry path is un-jittered

**Severity & Impact:** **High** — synchronised retry storms; a 3-second provider blip becomes a 3-minute outage because every client retries in lockstep.

**Location:**
- `packages/pycommon/pycommon/resilience.py` — `call_with_resilience`
- `apps/web/src/lib/socket.ts:94-105`
- `packages/backend-common/src/aws/messaging.ts:34-35`

```python
# resilience.py — exponential backoff, no jitter
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=0.2, max=2.0),      # ← deterministic
    retry=retry_if_exception_type(RETRYABLE_EXCEPTIONS),
    reraise=True,
)
async def _attempt():
    ...
```

```ts
// socket.ts
private scheduleReconnect(): void {
  if (this.reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_DELAY_BASE_MS * 2 ** this.reconnectAttempt,   // ← deterministic
    RECONNECT_DELAY_MAX_MS,
  );
  this.reconnectAttempt += 1;
  this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
}
```

```ts
// messaging.ts
const getSns = () => (snsClient ??= new SNSClient({ maxAttempts: 3 }));   // ← SDK default: exponential, no jitter
const getSqs = () => (sqsClient ??= new SQSClient({ maxAttempts: 3 }));
```

**The Flaw:**
Three layers of retry, all deterministic:

1. **`pycommon` tenacity** — `wait_exponential` without `wait_random_exponential`. Every container that started at the same moment (a burst, a cold-start wave, an EventBridge tick) retries at exactly 0.2 s, 0.4 s, 0.8 s.
2. **The browser socket** — `2 ** attempt` from a shared base. Every tab that lost the connection at the same instant (an API Gateway deploy, a stage redeploy) reconnects in lockstep.
3. **AWS SDK default retry** — `standard` mode with `maxAttempts: 3` uses exponential backoff *with* a jitter component in the SDK, but `maxAttempts` alone does not configure the delay; adding `adaptive` mode for DynamoDB/SQS is the documented remedy for exactly this.

The failure mode compounds: an SNS hiccup at 19:30 causes 400 concurrent `realtime.eventConsumer` invocations to fail, SNS redelivers, all 400 hit the topic simultaneously, the retry wave lands on the same second, the second wave lands on the same second two seconds later. This is the classic "thundering herd after a brief outage" — and at ~1,000 concurrency slots it can hold the whole platform down for minutes after the dependency recovered.

`docs/14-known-gaps.md §2.6` records the socket half. The Python half and the SDK configuration are not recorded.

**The Fix:**

```python
# pycommon/resilience.py
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_random_exponential

@retry(
    stop=stop_after_attempt(3),
    # Full jitter, capped at 2s. Spreads retries uniformly across the window
    # so a burst of concurrent callers cannot re-synchronise.
    wait=wait_random_exponential(multiplier=0.2, max=2.0),
    retry=retry_if_exception_type(RETRYABLE_EXCEPTIONS),
    reraise=True,
)
async def _attempt():
    ...
```

```ts
// messaging.ts — adaptive retry mode is the AWS-documented remedy for
// throttling storms; it rate-limits the client itself when it detects
// sustained throttling instead of blindly re-sending.
const getSns = () => (snsClient ??= new SNSClient({ maxAttempts: 3, retryMode: "adaptive" }));
const getSqs = () => (sqsClient ??= new SQSClient({ maxAttempts: 5, retryMode: "adaptive" }));
```

```ts
// socket.ts — full jitter, and a hard cap on attempts
const RECONNECT_DELAY_BASE_MS = 500;
const RECONNECT_DELAY_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 12;

private scheduleReconnect(): void {
  if (this.reconnectTimer) return;
  if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
    // Give up and surface it — a "reconnecting forever" tab is worse than
    // a visible disconnected state, because users stop trusting the UI.
    useSocketStore.getState().setConnected(false);
    this.dispatch("reconnect_failed", undefined);
    return;
  }
  // Full jitter: random between 0 and the capped exponential.
  const ceiling = Math.min(RECONNECT_DELAY_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_DELAY_MAX_MS);
  const delay = Math.random() * ceiling;
  this.reconnectAttempt += 1;
  this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
}
```

**Trade-offs:**
- Full jitter makes reconnect timing non-deterministic, which is harder to reason about in an incident. Log the chosen delay.
- Capping at 12 attempts (~10 minutes with jitter) means a long network partition leaves the user with a dead UI. Combine with B-08's "refetch on reconnect" so the UI falls back to polling/refetch and the socket becomes an optimisation rather than a requirement.
- `retryMode: "adaptive"` holds requests client-side under sustained throttling, which can make a slow-but-succeeding request look like a timeout. Tune against your `timeout` values (DynamoDB has `connect_timeout 3 / read_timeout 15` in `pycommon`; the Node docClient has no explicit timeouts — see M-12).

---

## B-08 · Reconciliation is capped at 100 candidates per hour with no failure destination

**Severity & Impact:** **High** — the safety net for the money path cannot keep up, and when it fails nothing is alerted.

**Location:**
- `backend/utils-service/serverless.yml:115-130`
- `backend/utils-service/src/config/reconciliation.ts`

```yaml
reconcile:
  handler: dist/reconciliation.handler
  timeout: 120
  memorySize: 256
  events:
    - schedule: rate(1 hour)      # ← no deadLetterConfig, no retries config
```

```ts
// reconciliation.ts
const candidates = await fetchCandidates({ olderThanMinutes: 20 });   // Limit: 100, payment-status GSI
for (const candidate of candidates) { ... }                            // sequential
```

**The Flaw:**
Three compounding limits:

1. **Throughput ceiling.** 100 orders/hour = 2,400/day. Any incident that produces more than 100 stuck payments in an hour (a webhook outage, a `markOrderPaid` throttling storm per B-04) overflows the window, and the *next* run re-queries from the same starting point — the GSI query is `Limit: 100` with no cursor persistence, so the 101st and beyond are never processed until the first 100 resolve. There is no pagination.

2. **No failure destination.** An `EventBridge Scheduler`/`schedule` invocation is an **asynchronous** Lambda invoke. Async invokes retry twice, then the event is **discarded** — unless a `deadLetterConfig`/`onFailure` is configured. None is. A `timeout: 120` against 100 sequential gateway calls (each up to 8 s via `runProvider`) means the function *will* time out — 100 × 8 s = 800 s vs a 120 s ceiling. So the routine outcome is a partial run, then two retries that redo the same first N candidates, then silence.

3. **No idempotency between runs.** Two overlapping runs (the retry after a timeout, plus the next hourly tick) both process the same candidates. Each does a gateway lookup and, potentially, a `markOrderPaid`. `markOrderPaid` is idempotent (conditional), so this is safe — but it doubles the gateway API cost and the DynamoDB reads.

**The Fix:**

```yaml
# utils-service/serverless.yml
reconcile:
  handler: dist/reconciliation.handler
  timeout: 300          # 100 candidates × up to 2.5s bounded each
  memorySize: 256
  reservedConcurrency: 1   # never two reconcilers at once
  # Async invokes that fail twice land in a DLQ instead of vanishing.
  onError: ${cf:${self:custom.infra}.ReconcileDlqArn}
  events:
    - schedule:
        rate: [rate(15 minutes)]
        enabled: true
```

```ts
// reconciliation.ts — bounded concurrency + cursor persistence + honest budgeting
import { mapWithConcurrency } from "@foodo/backend-common/aws";

const BATCH = 100;
const CONCURRENCY = 10;
const DEADLINE_MS = 240_000;             // leave 60s inside the 300s timeout

export const handler = async (): Promise<{ scanned: number; resolved: number; deferred: number }> => {
  const started = Date.now();
  let cursor: Record<string, unknown> | undefined;
  let scanned = 0, resolved = 0;

  do {
    const page = await fetchCandidatesPage({ olderThanMinutes: 20, limit: BATCH, exclusiveStartKey: cursor });
    scanned += page.items.length;

    const outcomes = await mapWithConcurrency(page.items, CONCURRENCY, async (candidate) => {
      try {
        return await resolveCandidate(candidate);
      } catch (err) {
        console.error(`[reconcile] ${candidate.id} failed:`, (err as Error)?.message);
        return false;
      }
    });
    resolved += outcomes.filter(Boolean).length;

    cursor = page.lastEvaluatedKey;

    if (Date.now() - started > DEADLINE_MS) {
      // Out of time: PERSIST the cursor so the next tick continues instead of
      // restarting at the top and starving everything past position 100.
      await saveCursor(cursor);
      return { scanned, resolved, deferred: 1 };
    }
  } while (cursor);

  await saveCursor(undefined);
  return { scanned, resolved, deferred: 0 };
};
```

**Trade-offs:**
- Every 15 minutes instead of hourly = 4× the GSI query cost. That query is small (a sparse index on `paymentStatus = "pending"`), so the delta is negligible against the risk of a 4-hour stuck-payment backlog.
- `reservedConcurrency: 1` guarantees the reconciler never contends with itself, at the cost of never overlapping either — a long run delays the next tick, which is the desired behaviour.
- Persisting a cursor introduces state that can go stale if the underlying rows are deleted. Guard with a re-query fallback when `saveCursor` points at a non-existent key.
- **The honest alternative:** if reconciliation is meant to be a rare safety net, `rate(1 hour)` + `Limit: 100` is defensible. What is not defensible is the absence of `onError` — that is a five-line change with no downside.

---

## B-09 · `isSeller` / `isAdmin` fail open when `req.user` is missing

**Severity & Impact:** **High (latent)** — defence-in-depth is inverted: a missing identity passes the role guard.

**Location:** `packages/backend-common/src/middlewares/isAuth.ts:103-149`

```ts
// ─── Role guards ─────────────────────────────────────────────
// Semantics preserved VERBATIM from the services, including the quirk that
// isSeller/isAdmin let an UNAUTHENTICATED request pass when `req.user` is
// unset (falsy guard) — only a present user with the wrong role is rejected.
// isRider is the inverse: a missing user is rejected.

export const isSeller = (req, res, next) => {
  const user = req.user;
  if (user && user.role !== "seller") {
    return res.status(401).json({ message: "You are not authorized seller" });
  }
  next();          // ← user === undefined falls through here
};

export const isRider = (req, res, next) => {
  const user = req.user;
  if (!user || user.role !== "rider") {   // ← correctly null-safe
    return res.status(401).json({ message: "You are not authorized rider" });
  }
  next();
};

export const isAdmin = (req, res, next) => {
  const user = req.user;
  if (user && user.role !== "admin") {    // ← same hole
    return res.status(401).json({ message: "You are not authorized" });
  }
  next();
};
```

**The Flaw:**
The comment is candid — this is a preserved quirk, not an oversight. Three of the four guards are correct; two are inverted.

Today the hole is **not exploitable** on the routes I traced, because `isAuth` precedes every `isSeller`/`isAdmin` in the routers and `isAuth` returns 401 when it cannot reconstruct a user:

```ts
// restaurant-service/src/routes/order.ts:31
router.get("/order/:restaurantId", isAuth, isSeller, fetchRestaurantOrders);
// restaurant-service/src/routes/restaurant.ts:23
router.use(isAuth, isSeller);
```

So `isSeller` never actually sees `user === undefined`.

But the guard is a **landmine with a specific arming mechanism**: the moment any future route uses `isSeller` without `isAuth` — the natural thing to do for a route that is "authenticated at the gateway, role-checked in-app", which is precisely the pattern the whole platform uses — the route is open to any authenticated user of any role *and* to the edge case where `req.user` fails to reconstruct.

And there is a real path for the latter: `isAuth` sets `req.user` from `gatewayClaims(req)`, which requires `requestContext.authorizer.lambda.sub`:

```ts
const claims = event?.requestContext?.authorizer?.lambda;
return claims?.sub ? (claims as GatewayClaims) : undefined;
```

If the authorizer is ever switched to `EnableSimpleResponses: false`, or a route is attached to a different authorizer that returns a differently-shaped context, `gatewayClaims` returns `undefined`, `req.session?.jwt` may be absent (it's a cookie, and the socket/Bearer clients have no cookie) — and `isAuth` 401s. Fine. But if the session cookie *is* present with a decodable-but-not-`typ:access` JWT, `isAuth` accepts it (it only decodes) and sets `req.user` — no, then `req.user` is set. The fail-open needs `req.user` **undefined**, which currently means `isAuth` returned 401 first.

So: latent, not live. Report it as such, and fix it anyway — it costs one boolean.

**The Fix:**

```ts
export const isSeller = (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  if (user.role !== "seller") return res.status(403).json({ message: "Not a seller" });
  next();
};

export const isAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  if (user.role !== "admin") return res.status(403).json({ message: "Not an admin" });
  next();
};

export const isRider = (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  if (user.role !== "rider") return res.status(403).json({ message: "Not a rider" });
  next();
};
```

**Trade-offs:**
- The status code changes from `401` to `403` for "authenticated but wrong role". Clients that branch on `401` to trigger a token refresh currently *cannot* distinguish the two — `401` on a role mismatch causes the client to attempt a refresh, get the same token back, and retry in a loop. `403` is both more correct and removes that loop. Update the axios interceptor to refresh only on `401` (which it already does) and to surface `403` as an authorisation error.
- Any client that currently depends on receiving `401` for "not a seller" will change behaviour. Grep the frontend for `status === 401` handling around seller routes before shipping.

---

## B-10 · `tryCatch` collapses every error into a 500 with the raw message

**Severity & Impact:** **High** — 403s become 500s, 404s become 500s, and internal error strings leak to clients.

**Location:** `packages/backend-common/src/middlewares/trycatch.ts:7-15` and its use at `backend/restaurant-service/src/controllers/order.ts:627-630`

```ts
export const tryCatch = (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });   // ← status + message both wrong
    }
  };
```

```ts
export const claimOrderForPaymentController = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    throw new Error("Forbidden");     // → 500 {"message":"Forbidden"}
  }
```

**The Flaw:**
Two problems in six lines:

1. **Status collapse.** `throw new Error("Forbidden")` is semantically a 403; it surfaces as `500`. That has three downstream effects: (a) `utils-service`'s `runProvider` breaker counts a 500 as a provider failure and can trip the circuit on an *auth misconfiguration*; (b) CloudWatch/API Gateway 5xx alarms fire on a 4xx condition; (c) the caller cannot distinguish "wrong key" from "DynamoDB is down" and so retries the wrong thing.

2. **Message leakage.** `error.message` of an arbitrary thrown value goes straight to the client. `@aws-sdk` errors carry `RequestId`, table names, and occasionally ARNs; a `TypeError: Cannot read properties of undefined (reading 'id')` tells an attacker exactly where the code is fragile. The admin service already has the correct variant and doesn't use it consistently:

```ts
// trycatch.ts:22-36 — this variant exists and is strictly better
export const tryCatchStatus = (handler) => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error: any) {
    const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600 ? error.status : 500;
    return res.status(status).json({ message: error.message });
  }
};
```

**The Fix:**

```ts
// packages/backend-common/src/middlewares/trycatch.ts
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = "HttpError";
  }
}
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg, "FORBIDDEN");
export const notFound  = (msg = "Not found") => new HttpError(404, msg, "NOT_FOUND");
export const conflict  = (msg: string, code?: string) => new HttpError(409, msg, code);

const SAFE_MESSAGE = /^(Unauthorized|Forbidden|Not found|.* is required|Invalid .*)$/i;

export const tryCatch = (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600 ? error.status : 500;

      // 5xx: never leak internals. The correlation id is what support needs;
      // the stack trace belongs in the log, not the response body.
      if (status >= 500) {
        const requestId = (req as any).apiGateway?.context?.requestId ?? "local";
        console.error(`[${requestId}] ${req.method} ${req.originalUrl} → ${status}`, error);
        return res.status(status).json({ message: "Internal server error", requestId });
      }

      const message = SAFE_MESSAGE.test(String(error?.message ?? "")) ? error.message : "Request rejected";
      return res.status(status).json({ message, ...(error?.code ? { code: error.code } : {}) });
    }
  };
```

```ts
// order.ts — the claim endpoint
if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
  throw forbidden("Internal key rejected");
}
```

Better still, replace the inline comparison with the shared middleware, which is already constant-time:

```ts
// restaurant-service/src/routes/order.ts
import { isInternal } from "@foodo/backend-common";
router.post("/payment/claim/:id", isInternal, claimOrderForPaymentController);
```

**Trade-offs:**
- Replacing `error.message` with a generic 5xx body will make some client error toasts less informative. That is the correct trade for not leaking internals, but it removes a debugging crutch — invest in the `requestId` correlation so support can still trace.
- `SAFE_MESSAGE` is a heuristic allow-list. It will occasionally pass something it shouldn't. The real fix is `HttpError` everywhere (explicit status + explicit safe message), with `tryCatch` treating anything that is not an `HttpError` as a 500 — do that incrementally.
- Changing 500→403 on the claim endpoint changes what `utils-service`'s breaker sees. Verify the breaker's `errorThresholdPercentage` is not configured to trip on 4xx (opossum counts *any* rejection by default; use `errorFilter` to exclude `HttpError` with status < 500).

---

## B-11 · `restaurant → ai-verification` is the only inter-service hop with no breaker and no retry

**Severity & Impact:** **High** — the kitchen's packing gate hangs for up to 25 s per request with no fail-fast, while every other hop in the platform is protected.

**Location:** `backend/restaurant-service/src/controllers/verification.ts`

```ts
const res = await fetch(`${base}/api/verification/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-internal-key": INTERNAL_KEY },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),   // 25_000
});
```

**The Flaw:**
Every other cross-service and third-party hop in this codebase has a breaker:

- `ai-verification/src/config/http.ts` — `claimBreaker`, `attachBreaker`, `backgroundBreaker`, `providerBreaker` (four isolated circuits).
- `ai-orchestrator/src/config/http.ts` — `opossum` breakers with `errorThresholdPercentage: 50`.
- `pycommon/resilience.py` — in-process `Breaker` + `EgressPools`.
- `utils-service` — `runProvider` wraps every Razorpay/Stripe/Cloudinary call.

The `restaurant → ai-verification` hop has **none**. It is a bare `fetch` with a 25 s timeout, inside a Lambda whose total timeout is 30 s (`restaurant-service/serverless.yml:134`).

So when `ai-verification` is slow (a vision model at 12 s × retries, or a cold start), the behaviour is:

1. Seller taps "verify packing".
2. `fetch` waits up to 25 s.
3. The Lambda has 5 s of headroom — enough for the response, not for a retry.
4. If the downstream is *dead* (not slow), the seller still waits the full 25 s. There is no fail-fast, because there is no circuit.

At 50 concurrent sellers that is 50 Lambda executions held for 25 s each = 1,250 s of concurrency, and the account-level effect described in B-01: checkout Lambdas waiting for slots because the packing gate is blocked on a dead AI tier.

There is a second-order bug: the handler passes `AbortSignal.timeout(25_000)` but the **caller** is `checkReadyGate`, and the packing gate is a *blocking* gate. So a dead AI tier blocks the order from advancing to `ready_for_rider` — the exact opposite of the design intent documented in `ai-verification/src/controllers/verification.ts:23-26`:

> *"The AI chain is allowed to be DOWN: the caller gets status 'unverified' (never a 5xx)"*

The verification *service* honours that. The *proxy* does not: a network timeout throws, and `checkReadyGate` treats it as a hard failure.

**The Fix:**

```ts
// restaurant-service/src/config/verificationClient.ts
import CircuitBreaker from "opossum";

const breaker = new CircuitBreaker(
  async (path: string, payload: unknown) => {
    const res = await fetch(`${process.env.AI_VERIFICATION_URL}/api/verification/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": process.env.INTERNAL_SERVICE_KEY! },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw Object.assign(new Error(`verification ${res.status}`), { status: res.status });
    return res.json();
  },
  {
    timeout: 9_000,
    errorThresholdPercentage: 50,
    resetTimeout: 15_000,
    volumeThreshold: 5,
  },
);

breaker.on("open", () => console.error("[BREAKER OPEN] ai-verification — packing gate degrading"));

export interface VerificationOutcome {
  status: "verified" | "flagged" | "unverified";
  [k: string]: unknown;
}

/** Never throws. A dead AI tier degrades to "unverified", matching the service contract. */
export async function requestVerification(path: string, payload: unknown): Promise<VerificationOutcome> {
  try {
    return (await breaker.fire(path, payload)) as VerificationOutcome;
  } catch (err) {
    console.error("[verification] degraded:", (err as Error)?.message);
    return { status: "unverified", flag: "AI_UNAVAILABLE", confidence: 0, degraded: true };
  }
}
```

Then the gate becomes:

```ts
// controllers/verification.ts
const outcome = await requestVerification("packing", payload);
// "unverified" is a first-class state — the seller sees "couldn't check the photo"
// and can retake or override, instead of staring at a spinner for 25 s.
```

**Trade-offs:**
- Dropping the timeout from 25 s to 8 s means the slowest legitimate vision call now degrades to `unverified`. Given the service's own default is `AI_TIMEOUT_MS = 12_000` (`ai-verification/src/config/ai.ts:54`), an 8 s ceiling will cut off some real calls. Raise the breaker timeout to 14 s (above the AI timeout, so the AI tier's own policy fires first) and keep `AbortSignal` at 15 s.
- `unverified` silently degrading could mask a chronic AI outage — the flag `AI_UNAVAILABLE` must feed an alarm, or sellers will quietly approve everything.
- Adding `opossum` to `restaurant-service` adds ~15 KB to the bundle. It is already a dependency of `ai-verification` and `ai-orchestrator`, so it is not new to the platform.

---

## B-12 · The login brute-force counter and the payment limiter are per-container

**Severity & Impact:** **High** — the rate limits are advisory; the effective limit is `configured × warm containers`.

**Location:**
- `backend/auth-service/src/middlewares/rate-limit.ts:16-87`
- `backend/utils-service/src/config/rate-limit.ts`

```ts
// auth-service — express-rate-limit's default MemoryStore
export const authFloodLimiter = rateLimit({
  ...base,
  windowMs: 5 * 60_000,
  limit: 20,              // ← 20 per container, not 20 per IP
  keyGenerator: ipKey,
  message: { message: "Too many attempts — try again later" },
});

// and a hand-rolled Map, explicitly acknowledged as per-process
const failureCounts = new Map<string, { count: number; resetAt: number }>();
const FAILURE_LIMIT = 10;
```

```ts
// The comment is honest about it:
// Store: in-memory (per-process). When auth scales past a couple of
// pods, plug in the Redis store (rate-limit-redis + REDIS_URL) the same
// way the utils service does.
```

**The Flaw:**
Two independent mis-modellings of the runtime:

1. **"pods" is the wrong mental model.** Lambda has no stable pod; it has an unbounded, autoscaling pool of execution environments. `auth-service` at 100 concurrent logins has ~100 containers. `limit: 20` therefore permits **2,000** requests per 5 minutes, and `FAILURE_LIMIT = 10` permits **1,000** failed passwords per 15 minutes against a single account — before any shared state exists to notice.

2. **The failure map is per-container and dies with the container.** `failureCounts` is a module-level `Map`. A container that serves one login and dies takes its counter with it. Credential stuffing across thousands of short-lived containers is effectively *unlimited* by this mechanism — each attempt starts from zero.

The comment says "the same way the utils service does" — but `utils-service/src/config/rate-limit.ts` also uses the in-memory store. The only service that got this right is `ai-verification`:

```ts
// ai-verification/src/config/rate-limit.ts:28-34 — the correct pattern, already in the repo
store: createDynamoRateLimitStore({
  prefix: "verification",
  windowMs: 60_000,
  limit: 120,
}),
```

`createDynamoRateLimitStore` exists in `packages/backend-common/src/dynamo/rateLimit.ts` and is backed by the `RateLimitsTable` that `infra` already provisions. `utils-service` even has `RATE_LIMIT_TABLE` in its environment (`utils-service/serverless.yml:59`) and its IAM (`:89-91`) — and does not use it.

**The Fix:**

```ts
// auth-service/src/middlewares/rate-limit.ts
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createDynamoRateLimitStore } from "@foodo/backend-common/dynamo";

export const authFloodLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  // Shared across every warm container — the only way a Lambda limiter
  // means what it says.
  store: createDynamoRateLimitStore({ prefix: "auth-flood", windowMs: 5 * 60_000, limit: 20 }),
  message: { message: "Too many attempts — try again later" },
});

export const bruteForceLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by IP+email so the ACCOUNT budget is burned, not the IP's —
  // an attacker rotating IPs still exhausts the target account's window.
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? "unknown")}:${
      typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "no-email"
    }`,
  store: createDynamoRateLimitStore({ prefix: "auth-bruteforce", windowMs: 15 * 60_000, limit: 10 }),
  skipSuccessfulRequests: true,   // the library's own mechanism — delete recordAuthFailure/clearAuthFailures
  message: { message: "Too many failed attempts — try again later" },
});
```

```ts
// routes/auth.ts
router.post("/login", authFloodLimiter, bruteForceLimiter, loginUser);
```

And do the same in `utils-service/src/config/rate-limit.ts` (it already has the table name and the IAM).

Also add a limit to `/refresh`, which currently has **none** and is public at the gateway:

```ts
// routes/auth.ts — /refresh is unauthenticated by design (the token IS the credential),
// so it needs its own budget or it is a free DynamoDB GSI query per request.
const refreshLimiter = rateLimit({
  windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  store: createDynamoRateLimitStore({ prefix: "auth-refresh", windowMs: 60_000, limit: 20 }),
});
router.post("/refresh", refreshLimiter, refreshUser);
```

**Trade-offs:**
- Every login now costs 2 extra DynamoDB writes (one per limiter) plus reads. At 20 logins/minute that is negligible; at 2,000/minute it is 4,000 WCU — which is the point.
- `createDynamoRateLimitStore` **fails open** when DynamoDB is unreachable (documented in `packages/backend-common/src/dynamo/rateLimit.ts`). That is the right call for a limiter, but it means a DynamoDB outage also removes rate limiting. Accept it; the alternative (fail closed) turns a table outage into a total auth outage.
- `skipSuccessfulRequests: true` changes the counter semantics — a user who fails 9 times then succeeds has their window cleared. That is the desired behaviour, but it means `recordAuthFailure`/`clearAuthFailures` (and their `setInterval` cleanup) must be deleted, which is a behaviour change to verify against the existing tests.
- `RateLimitsTable` is `PAY_PER_REQUEST` with no PITR — fine for ephemeral counters, but the table will now take real write volume; add a TTL on its window keys so it does not grow unbounded (verify the existing store already does this).

---

## B-13 · The browser reconnects forever using a token it never refreshes

**Severity & Impact:** **High** — every tab becomes a permanent 5-second failed-handshake loop 15 minutes after page load; realtime silently dies and the user is never told.

**Location:**
- `apps/web/src/lib/socket.ts:29-105`, `:153-167`
- `backend/auth-service/src/controllers/socket-token.ts:16-20`

```ts
class RealtimeSocket {
  private token: string;

  constructor(token: string) {
    this.token = token;        // ← assigned once, never replaced
  }

  connect(): void {
    const ws = new WebSocket(`${REALTIME_WS_URL}?token=${encodeURIComponent(this.token)}`);
    ...
    ws.onclose = () => {
      this.connected = false;
      useSocketStore.getState().setConnected(false);
      // Never give up: retry forever with capped backoff.
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_DELAY_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_DELAY_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }
```

```ts
// auth-service/src/controllers/socket-token.ts
token: signAccessToken(claims.sub, claims.role),   // expiresIn: 15 * 60
expiresIn: 15 * 60,
```

**The Flaw:**
The token is valid for **15 minutes**. It is captured in the constructor and reused for every subsequent `new WebSocket(...)`. `scheduleReconnect` calls `this.connect()` — which re-uses `this.token` verbatim. There is no refresh, no expiry check, no `expiresIn` arithmetic anywhere in the client.

So the lifecycle of a long-lived tab is:

1. `t = 0` — `connectSocket()` calls `fetchSocketToken()`, constructs `RealtimeSocket(freshToken)`, connects. Works.
2. `t = 15 min` — the JWT expires. The connection itself is still open, so nothing happens.
3. `t = 15 min + ε` — any network blip (laptop sleep, wifi roam, mobile handover, API Gateway idle timeout) closes the socket.
4. `onclose` → `scheduleReconnect()` → `connect()` → `new WebSocket('...?token=<expired>')`.
5. `$connect` runs `jwt.verify(cleanToken, ...)`, throws `TokenExpiredError`, returns `fail(401, "Invalid token")`.
6. The WebSocket handshake is rejected. The browser fires `onclose` with code `1006` (no status reason available to JS).
7. Back to step 4. **Forever.**

`reconnectAttempt` only resets on `onopen`, which never fires again, so the delay saturates at `RECONNECT_DELAY_MAX_MS = 5000` and stays there. Every 5 seconds, for the rest of the tab's life:

- one WebSocket handshake attempt (network),
- one API Gateway WebSocket message-request meter,
- one `wsRouter` Lambda invocation (which does a `jwt.verify` that fails),
- one `$context.error.messageString` log line.

Per tab: 720 attempts/hour → ~17,000/day → ~518,000/month. Individually cheap; the real damage is:

- **The user's UI stops updating and looks fine.** `use-realtime-order-sync` invalidates query caches on socket events; with a dead socket, an order stuck in `placed` never refreshes. TanStack Query's `refetchOnWindowFocus: false` (`providers/query-provider.tsx`) means the fallback does not rescue it either. The customer sees a stale order and calls support.
- **The `$connect` Lambda is invoked with a guaranteed failure** — 518k wasted invocations per idle tab, all counted against the same account concurrency pool that B-01 shows is already unprotected.
- It is invisible: `onerror` only flips a store flag, and `onclose` does not distinguish "network blip" from "auth rejected" (it cannot — JS gets `1006` for both).

**The Fix:**
Re-mint before reconnecting, and give up (visibly) rather than loop.

```ts
// apps/web/src/lib/socket.ts
import { useSocketStore } from "@/store/socket-store";
import { fetchSocketToken, getSocketToken, clearSocketToken } from "./api-client";

const REALTIME_WS_URL = process.env.NEXT_PUBLIC_REALTIME_WS_URL || "ws://localhost:3002";
const RECONNECT_DELAY_BASE_MS = 500;
const RECONNECT_DELAY_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 12;
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Decode `exp` without a library — the payload is base64url, no verification needed client-side. */
function tokenExpiresAt(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

class RealtimeSocket {
  private token: string | null = null;
  private tokenRefresh: Promise<string | null> | null = null;

  /** Always hands back a token with at least 60s of life left. */
  private async freshToken(): Promise<string | null> {
    if (this.token && tokenExpiresAt(this.token) - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return this.token;
    }
    // De-duplicate concurrent refreshes (reconnect storm after sleep).
    this.tokenRefresh ??= (async () => {
      clearSocketToken();
      const minted = await fetchSocketToken();   // authenticated by the session cookie
      this.token = minted;
      this.tokenRefresh = null;
      return minted;
    })();
    return this.tokenRefresh;
  }

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.closedByUser = false;
    const token = await this.freshToken();
    if (!token) {
      // No session at all — do not spin. Surface it; the auth layer will redirect.
      this.dispatch("auth_failed", undefined);
      useSocketStore.getState().setConnected(false);
      return;
    }

    const ws = new WebSocket(`${REALTIME_WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      useSocketStore.getState().setConnected(true);
      this.dispatch("connect", undefined);
    };

    ws.onclose = () => {
      this.connected = false;
      useSocketStore.getState().setConnected(false);
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => { useSocketStore.getState().setConnected(false); };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.dispatch("reconnect_failed", undefined);
      return;                                  // stop the loop; the UI shows "offline"
    }
    const ceiling = Math.min(RECONNECT_DELAY_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_DELAY_MAX_MS);
    const delay = Math.random() * ceiling;     // full jitter — see B-07
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
  }
}
```

Two supporting changes:

```ts
// apps/web/src/lib/api-client.ts — the in-memory token must be clearable
let socketToken: string | null = null;
export function getSocketToken() { return socketToken; }
export function setSocketToken(t: string | null) { socketToken = t; }
export function clearSocketToken() { socketToken = null; }
```

```ts
// apps/web/src/providers/socket-provider.tsx — refetch whatever the socket would have pushed
useEffect(() => {
  const socket = getSocket();
  if (!socket) return;
  const onReconnect = () => queryClient.invalidateQueries();   // catch up on anything missed
  socket.on("connect", onReconnect);
  return () => socket.off("connect", onReconnect);
}, [queryClient]);
```

**Trade-offs:**
- Every reconnect now costs a `GET /api/auth/socket-token` round trip (which itself needs the session cookie to still be valid). After the session expires (~15 min, `cookieSessionOptions().maxAge = ACCESS_TTL_SEC * 1000`) that call 401s, `freshToken()` returns `null`, and the socket gives up with `auth_failed` — correct, but it means long-lived tabs need the app's refresh flow to keep the *session* alive, not just the socket. Verify that the refresh interceptor (`POST /api/auth/refresh`) runs on that 401; otherwise the socket is the first thing to notice an expired session and the UX is a silent dead socket rather than a login redirect.
- Giving up after 12 attempts changes "eventually works when the network returns" into "needs a page refresh". That is a real regression for flaky mobile networks. Mitigate by resetting `reconnectAttempt` on `visibilitychange → visible` and on `online`, which is where the user's attention returns anyway.
- `void this.connect()` in the timer makes `connect()` async at the call site. `connectSocket()` must `await` it or the function returns before the socket exists — check every caller (`providers/socket-provider.tsx`).

---

# Part C — Medium (data access, correctness, and code-level performance)

## C-01 · The cart path issues one `GetItem` per item — an N+1 straight out of the textbook

**Severity & Impact:** **Medium** — latency and request cost scale linearly with cart size, on the highest-traffic read path in the product.

**Location:** `backend/restaurant-service/src/dynamo/cart.ts:169-194`

```ts
/**
 * Menu enrichment for getCart/createOrder: batch GetMenuItem rows for
 * the cart's item ids (replaces the populate("itemId") round-trip).
 */
export async function fetchMenuItemsForCart(itemIds: string[]): Promise<Map<string, DynamoMenuItem>> {
  const out = await Promise.all(
    itemIds.map((id) =>
      docClient()
        .send(new GetCommand({ TableName: TABLE.menuItems(), Key: { pk: `MENU#${id}`, sk: "ITEM" } }))
        .then((r) => toMenuItem(r.Item as Record<string, unknown> | undefined))
        .catch(() => null),
    ),
  );
  ...
}
```

**The Flaw:**
The doc comment says "batch GetMenuItem rows" — it does not batch. `Promise.all` over N `GetCommand` calls is N round-trips issued concurrently. Concurrent does not mean free:

- **Billed requests:** N `GetItem` requests instead of `ceil(N/100)` `BatchGetItem` requests. At 8 items/cart that is 8× the request count on every cart load and every `createOrder` (which calls this to compute totals).
- **Connection pressure:** each in-flight `GetItem` is an HTTP/2 stream against DynamoDB. A 30-item cart opens 30 streams from a single Lambda; a cold container has to establish 30 TLS-adjacent streams to a fresh connection.
- **`catch(() => null)` masks a whole missing item.** A throttled `GetItem` becomes "this menu item does not exist", and `createOrder` then either drops the line silently or throws a confusing "item unavailable" — see B-04 for the same disease.

`createOrder` calls this on the *write* path to recompute totals server-side (`order.ts`), so it runs on every checkout.

**The Fix:**

```ts
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const BATCH_GET_MAX = 100;   // DynamoDB hard limit per BatchGetItem

export async function fetchMenuItemsForCart(itemIds: string[]): Promise<Map<string, DynamoMenuItem>> {
  const map = new Map<string, DynamoMenuItem>();
  const unique = [...new Set(itemIds.filter(Boolean))];
  if (unique.length === 0) return map;

  const keys = unique.map((id) => ({ pk: `MENU#${id}`, sk: "ITEM" }));

  for (let start = 0; start < keys.length; start += BATCH_GET_MAX) {
    let pending: Record<string, unknown>[] | undefined = keys.slice(start, start + BATCH_GET_MAX);
    let attempts = 0;

    // BatchGetItem returns UnprocessedKeys under load — retry them with
    // backoff instead of pretending the items do not exist.
    while (pending?.length && attempts < 3) {
      const out = await docClient().send(
        new BatchGetCommand({
          RequestItems: {
            [TABLE.menuItems()]: { Keys: pending, ConsistentRead: false, ProjectionExpression: "id, restaurantId, #n, description, price, category, image, isAvailable", ExpressionAttributeNames: { "#n": "name" } },
          },
        }),
      );

      for (const raw of out.Responses?.[TABLE.menuItems()] ?? []) {
        const item = toMenuItem(raw);
        if (item) map.set(item.id, item);
      }

      pending = out.UnprocessedKeys?.[TABLE.menuItems()]?.Keys as Record<string, unknown>[] | undefined;
      if (pending?.length) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempts + Math.random() * 50));
      }
    }

    if (pending?.length) {
      console.error(`[cart] BatchGetItem left ${pending.length} unprocessed key(s) after 3 attempts`);
      throw new Error("Menu lookup temporarily unavailable");
    }
  }

  return map;
}
```

**Trade-offs:**
- `BatchGetItem` cannot span tables; fine here (one table).
- Unprocessed keys must be handled or you silently lose items — the `while` loop is not optional. The alternative (throw) converts a transient partial failure into a checkout error, which is the honest behaviour but a worse UX; retrying first is the right balance.
- `ProjectionExpression` reduces payload but couples the function to the attribute list. Use it (cart reads never need `createdAt`/`updatedAt`), but keep the list next to the `DynamoMenuItem` interface so it drifts visibly.
- Consistent reads off (default): a menu item created 200 ms ago may not be visible in a cart. Already true today (the `GetItem` is also eventually consistent unless specified), so no behaviour change.

---

## C-02 · `clearCart` issues one `DeleteItem` per row — and `createOrder` stuffs them all into one transaction

**Severity & Impact:** **Medium** — write amplification on every checkout, and a hard 100-item ceiling that fails the checkout rather than degrading.

**Location:** `backend/restaurant-service/src/dynamo/cart.ts:154-167`, and `packages/backend-common/src/dynamo/Order.ts` (`createOrder` → `TransactWriteCommand`)

```ts
/** Clear cart: delete every row of the user's partition. */
export async function clearCart(userId: string): Promise<void> {
  const rows = await getCartRows(userId);
  await Promise.all(
    rows.map((r) => docClient().send(new DeleteCommand({ TableName: TABLE.carts(), Key: { pk: r.pk, sk: r.sk } }))),
  );
}
```

**The Flaw:**
Two problems:

1. **`clearCart` is N `DeleteItem` calls.** It should be one `BatchWriteItem` (25 items per request, i.e. `ceil(N/25)`). It is called from `onPaymentSuccess` — the payment webhook consumer — so every successful payment writes N+delete requests in the same 30 s budget that also does `markOrderPaid`, `stampProviderPaymentId` and three SNS publishes.

2. **`createOrder` deletes cart rows inside `TransactWriteItems`**, which has a **hard limit of 100 actions**. The transaction is `1 Put (order) + N Delete (cart rows)`. A cart with 100 distinct items produces 101 actions and DynamoDB rejects the whole transaction with `ValidationException` — the customer cannot check out at all, with an error that looks like a server fault. The limit is not a soft guideline; `TransactionCanceledException`/`ValidationException` is returned before any write happens.

**The Fix:**

```ts
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const BATCH_WRITE_MAX = 25;

export async function clearCart(userId: string): Promise<void> {
  const rows = await getCartRows(userId);
  if (rows.length === 0) return;

  for (let start = 0; start < rows.length; start += BATCH_WRITE_MAX) {
    let pending = rows.slice(start, start + BATCH_WRITE_MAX).map((r) => ({
      DeleteRequest: { Key: { pk: r.pk, sk: r.sk } },
    }));
    let attempts = 0;

    while (pending.length && attempts < 3) {
      const out = await docClient().send(
        new BatchWriteCommand({ RequestItems: { [TABLE.carts()]: pending } }),
      );
      pending = (out.UnprocessedItems?.[TABLE.carts()] ?? []) as typeof pending;
      if (pending.length) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempts + Math.random() * 50));
      }
    }
    if (pending.length) throw new Error("Cart clear partially failed — retry");
  }
}
```

For `createOrder`, **stop deleting cart rows transactionally**. The order `Put` is the atomic part that matters; the cart cleanup is a best-effort side effect that must not be able to veto a checkout:

```ts
// Order.ts — createOrder
// The order write must be atomic. The cart cleanup is a follower action:
// if it fails, the worst case is a stale cart that the next add/remove
// reconciles. A 100-item cart must never be able to block checkout.
await docClient().send(
  new TransactWriteCommand({
    TransactItems: [{ Put: { TableName: TABLE.orders(), Item: orderRow, ConditionExpression: "attribute_not_exists(pk)" } }],
  }),
);

// Then, outside the transaction:
await clearCart(userId).catch((err) => {
  console.error(`[order] cart cleanup failed for ${userId} (order ${orderRow.id} placed):`, err);
});
```

If keeping cart-clear inside the transaction is a product requirement (it prevents the customer from re-ordering the same items by refreshing), then chunk instead: transaction 1 = order + first 99 deletes; then `BatchWriteItem` for the rest. But the simpler ordering above is better — an order that exists is worth more than a cart that is empty.

**Trade-offs:**
- De-transactionalising the cart clear introduces a window where an order exists and the cart is still populated. A user could double-order by hitting "checkout" again. Guard it with an idempotency key on `createOrder` (a `clientOrderId` from the frontend, `ConditionExpression: attribute_not_exists(clientOrderId)` on a dedupe row) — which the order path arguably needs anyway.
- `BatchWriteItem` is not atomic; a partial failure leaves a partially-cleared cart. Acceptable for a cart, unacceptable for an order — hence the split.
- `clearCart` still costs `ceil(N/25)` requests. For a 40-item cart that is 2 instead of 40.

---

## C-03 · GSI `FilterExpression` + `Limit` is a pagination bug in four repositories

**Severity & Impact:** **Medium** — pages silently return fewer rows than requested, and "load more" can stall or skip.

**Location:**
- `packages/backend-common/src/dynamo/Order.ts:142-159` (`listOrdersByUser`)
- `Order.ts:166-196` (`listOrdersByRestaurant`)
- `ai-dispatch/app/services/dispatch_service.py` (`_pop_pool_candidates`, `snapshot`)

```ts
export async function listOrdersByUser(userId: string, limit = 50): Promise<DynamoOrder[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "user-orders",
      KeyConditionExpression: "userId = :u",
      // paymentStatus is the GSI sort-key prefix guard: paid rows only
      FilterExpression: "paymentStatus = :paid",
      ExpressionAttributeValues: { ":u": userId, ":paid": "paid" },
      ScanIndexForward: false,
      Limit: limit,          // ← limit applies BEFORE the filter
    }),
  );
  return (out.Items as DynamoOrder[]) ?? [];
}
```

**The Flaw:**
In DynamoDB, `Limit` caps the number of items **evaluated**, not the number returned. A `FilterExpression` is applied afterwards. So `Limit: 50` with a filter means: read up to 50 rows, discard the non-matching ones, return whatever is left — possibly 3, possibly 0.

For `listOrdersByUser`, the failure is progressive and gets worse over time: a user's first orders are all `paid`, so the first page fills. Later, as unpaid/abandoned orders accumulate in the same partition, page 1 returns 50 evaluated → maybe 30 returned. As abandoned checkouts grow, the page shrinks toward zero. Meanwhile the caller has no idea a filter was applied, so it believes "this user has 30 orders" when they have 200.

`listOrdersByRestaurant` is worse because it also does keyset pagination (`limit + 1` for `hasMore`). If the filter discards the extra row, `hasMore` becomes `false` while more paid orders exist beyond the 51st evaluated row. The cursor is built from `(createdAt, id)` so it resumes correctly *if* the client keeps asking — but the client stops because `nextCursor` is `null`.

The comment `// paymentStatus is the GSI sort-key prefix guard` is simply wrong: `paymentStatus` is not part of the `user-orders` key schema (`pk` = `userId`, `sk` = `createdAt`).

**The Fix — two options, pick per query:**

**Option 1 (preferred): remove the filter from the query and filter after.** Read `Limit + N` and stop when enough rows survive. Keeps the index design and is honest about cost.

```ts
export async function listOrdersByUser(userId: string, limit = 50): Promise<DynamoOrder[]> {
  const collected: DynamoOrder[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLE.orders(),
        IndexName: "user-orders",
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ScanIndexForward: false,
        Limit: Math.max(limit - collected.length, 25),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );

    for (const row of (out.Items as DynamoOrder[]) ?? []) {
      if (row.paymentStatus === "paid") collected.push(row);
      if (collected.length >= limit) break;
    }

    exclusiveStartKey = out.LastEvaluatedKey;
    pages += 1;
  } while (collected.length < limit && exclusiveStartKey && pages < 4);   // bounded: ≤4 round trips

  return collected;
}
```

**Option 2 (structurally correct): make `paymentStatus` part of the key.** Add a composite sort key so the filter becomes a key condition:

```
sk = `${paymentStatus}#${createdAt}`
```

Then `KeyConditionExpression: "userId = :u AND begins_with(sk, :paidPrefix)"` is a real key condition, `Limit` means what they think it means, and the read cost halves (no discarded items). This is the design the current comments *describe* but the schema does not implement.

For `dispatch_service.snapshot()`, the scan with `begins_with(pk, "POOL#")` + filter is covered in C-04.

**Trade-offs:**
- Option 1 costs more RCU on sparse pages (reading rows that get discarded) and adds up to 3 extra round trips for a sparse page. Bounded at 4 pages so it cannot loop.
- Option 2 is a schema migration: every order write must compose the new `sk`, every existing order needs a backfill, and the `restaurant-orders`/`status-board` GSIs need their own projection decisions. That is the right long-term shape, but it is a migration with a dual-write window — do not attempt it casually.
- Until either fix lands, document the actual semantics on the function so callers do not build pagination on a lie.

---

## C-04 · Three production endpoints do full-table `Scan`s

**Severity & Impact:** **Medium** — cost and latency scale with *total table size*, not with the request; at 1M orders the admin dashboard reads 1M rows to render four numbers.

**Location:**
1. `packages/backend-common/src/dynamo/Rider.ts` — `listAllRiders()`
2. `backend/admin-service/src/controllers/admin.ts` — `getPlatformStats`
3. `backend/ai-dispatch/app/services/dispatch_service.py` — `snapshot()`

```ts
// Rider.ts
export async function listAllRiders(): Promise<DynamoRider[]> {
  const out = await docClient().send(new ScanCommand({ TableName: TABLE.riders() }));
  return (out.Items as DynamoRider[]) ?? [];   // also ignores LastEvaluatedKey → silently truncated at 1 MB
}
```

```ts
// admin.ts — getPlatformStats
const ordersOut = await docClient().send(new ScanCommand({ TableName: TABLE.orders() }));
const [restaurants, riders, users] = await Promise.all([listAllRestaurants(), listAllRiders(), listUsers(1000)]);
...
thisMonth: monthRevenue > 0 ? monthRevenue : totalRevenue,   // shows an all-time figure as "this month"
monthChange: null,
```

```python
# dispatch_service.py — snapshot()
response = _state().scan(FilterExpression=("begins_with(pk, :pool) AND ..."), Limit=100)
```

**The Flaw:**
Four things, in decreasing severity:

1. **`Scan` without pagination returns at most 1 MB.** `listAllRiders` and `getPlatformStats` both read `Items` and ignore `LastEvaluatedKey`. Above 1 MB (≈ 2,000–4,000 riders, fewer orders), the result is **silently truncated**. The admin revenue figure is then simply wrong — not slow, wrong — and nobody knows at which row count it broke.

2. **Cost is O(table).** Every dashboard load reads the entire orders table. At 1M orders × ~1 KB = 1 GB = 250,000 RCU per page load. A dashboard refreshing every 60 s costs more than the entire checkout path.

3. **`monthRevenue > 0 ? monthRevenue : totalRevenue`** is a silent data-integrity bug: on the 1st of the month (or any month with zero revenue), the dashboard reports *all-time* revenue labelled as this month. It also silently converts a bug (monthRevenue miscomputed as 0) into a plausible-looking number.

4. **`Limit: 100` on the dispatch scan** is applied before the `FilterExpression` — the C-03 bug in Python. The ops snapshot can return an empty pool while riders are actively being assigned.

**The Fix:**

For the admin dashboard, do not scan — maintain aggregates. A counter row updated on each order transition is the standard DynamoDB pattern and it is *cheap*:

```ts
// packages/backend-common/src/dynamo/aggregates.ts
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

const monthKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Daily + monthly rollup rows in a dedicated table. One UpdateItem per order
 * transition — ~6 extra writes per order, versus a full-table Scan per
 * dashboard load.
 *
 *   PK: AGG#<yyyy-mm>   SK: DAY#<yyyy-mm-dd> | TOTAL
 */
export async function bumpOrderAggregate(order: { totalAmount: number; status: string; at?: string }) {
  const at = order.at ? new Date(order.at) : new Date();
  const day = at.toISOString().slice(0, 10);
  const amount = Math.round(Number(order.totalAmount ?? 0) * 100);   // store paise, integer

  await docClient().send(
    new UpdateCommand({
      TableName: TABLE.aggregates(),
      Key: { pk: `AGG#${monthKey(at)}`, sk: `DAY#${day}` },
      UpdateExpression:
        "ADD orderCount :one, revenuePaise :amt SET updatedAt = :now",
      ExpressionAttributeValues: { ":one": 1, ":amt": amount, ":now": new Date().toISOString() },
    }),
  );
}
```

Then the dashboard reads **12 `GetItem`s** (one per month) instead of scanning:

```ts
// admin.ts — getPlatformStats
const now = new Date();
const months = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
});

const totals = await Promise.all(
  months.map((m) =>
    docClient().send(new GetCommand({ TableName: TABLE.aggregates(), Key: { pk: `AGG#${m}`, sk: "TOTAL" } }))
      .then((r) => (r.Item as { revenuePaise?: number; orderCount?: number } | undefined) ?? { revenuePaise: 0, orderCount: 0 }),
  ),
);

const thisMonth = totals[0]!.revenuePaise ?? 0;
const lastMonth = totals[1]!.revenuePaise ?? 0;
const monthChange = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;   // null is honest, not 0
```

For `listAllRiders`, the callers are `admin.getPlatformStats` and rider listing. Paginate honestly:

```ts
export async function listAllRiders(maxPages = 20): Promise<DynamoRider[]> {
  const out: DynamoRider[] = [];
  let key: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const page = await docClient().send(new ScanCommand({ TableName: TABLE.riders(), ...(key ? { ExclusiveStartKey: key } : {}) }));
    out.push(...((page.Items as DynamoRider[]) ?? []));
    key = page.LastEvaluatedKey;
    pages += 1;
  } while (key && pages < maxPages);
  if (key) console.warn(`[riders] listAllRiders truncated at ${pages} pages — use an index or an aggregate`);
  return out;
}
```

Better: give `RidersTable` a `status-index` GSI keyed on `isVerified`/`isAvailable` (it already has `verified-index`) and never scan at all.

For `dispatch_service.snapshot()`, replace the scan with a query on a dedicated partition:

```python
# Pool rows get their own partition so the snapshot is ONE query, not a scan.
#   PK: POOL           SK: <riderId>
#   PK: READY#<order>  SK: SEEN            (claim, unchanged)
def snapshot(self):
    response = _state().query(
        KeyConditionExpression=Key("pk").eq("POOL"),
        Limit=100,
    )
```

**Trade-offs:**
- Aggregates are eventually consistent with the orders table and require a backfill from existing data. A missing `bumpOrderAggregate` call (a new code path that writes orders) silently under-counts — mitigate by making the aggregate bump part of the same `UpdateItem`-adjacent helper that every status transition already goes through (`setOrderStatus`), not a separate call site.
- Storing paise as integers avoids float drift but changes the unit; every reader must divide by 100. Keep the unit in the attribute name (`revenuePaise`) so it cannot be mistaken.
- Moving dispatch pool rows to a single partition makes that partition a potential hot key. At realistic rider counts (thousands, written every few seconds) it is fine; if it ever exceeds ~1,000 WCU sustained, shard it (`POOL#<shard>`) and fan out the snapshot query.
- Deleting `listAllRiders`'s scan-based behaviour changes an admin page that currently (accidentally) returns at most 1 MB. After the fix it returns *more* rows and may be slower — check whether the admin UI can handle thousands of riders before shipping.

---

## C-05 · `createRider`'s phone-uniqueness check queries the wrong attribute — twice

**Severity & Impact:** **Medium** — duplicate phone numbers are accepted, so the same person can register multiple rider accounts and any phone-keyed lookup (support, dispatch, KYC) becomes ambiguous.

**Location:** `packages/backend-common/src/dynamo/Rider.ts`

```ts
export async function createRider(input: {...}) {
  const [byUser, byPhone] = await Promise.all([
    getRiderByUserId(input.userId),
    docClient().send(
      new QueryCommand({
        TableName: TABLE.riders(),
        IndexName: "user-index",
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": input.userId },     // ← userId, not phone
        Limit: 1,
      }),
    ),
  ]);

  if (byUser || (byPhone.Items?.length ?? 0) > 0) throw ...;
}
```

**The Flaw:**
`byPhone` is a copy-paste of `byUser`: it queries `user-index` on `userId = input.userId`. Therefore:

- `byUser` and `byPhone` return the **same row** (or both empty).
- The condition `byUser || byPhone.Items.length > 0` is logically identical to `byUser`.
- **Phone uniqueness is never checked.** Two riders can share a phone; a single phone can back unlimited rider accounts.
- It also costs a **second identical query** on every registration — pure waste, since the first query already answered it.

The index it *should* use does not exist: `RidersTable` has `user-index` (`userId`) and `verified-index` (`isVerified`) — there is no phone index (`infra/serverless.yml:389-397`).

**The Fix:**
Add a sparse phone index and query it correctly. Because phone numbers are unique-per-identity, a GSI with a *composite* condition isn't needed — a plain GSI on `phone` with a `ConditionExpression` on write is enough, and the write guard is what actually enforces uniqueness under concurrency.

```yaml
# infra/serverless.yml — RidersTable.GlobalSecondaryIndexes
- IndexName: phone-index
  KeySchema:
    - { AttributeName: phone, KeyType: HASH }
  Projection: { ProjectionType: KEYS_ONLY }    # existence check only — do not duplicate the row
```

```ts
export async function createRider(input: { userId: string; phone: string; ... }): Promise<DynamoRider> {
  // One query, one purpose. The GSI is KEYS_ONLY so this is the cheapest read DynamoDB offers.
  const existing = await docClient().send(
    new QueryCommand({
      TableName: TABLE.riders(),
      IndexName: "phone-index",
      KeyConditionExpression: "phone = :p",
      ExpressionAttributeValues: { ":p": String(input.phone) },
      Limit: 1,
    }),
  );

  if ((existing.Items?.length ?? 0) > 0) {
    throw Object.assign(new Error("A rider with this phone number already exists"), { status: 409 });
  }

  // The query above is a convenience check (nice error message). The INDEX
  // cannot guarantee uniqueness under concurrency — the write must.
  try {
    const row: DynamoRider = { ..., phone: String(input.phone) };
    await docClient().send(
      new PutCommand({
        TableName: TABLE.riders(),
        Item: row,
        // One rider per user. (DynamoDB has no cross-item unique constraint,
        // so phone uniqueness is enforced by making the phone the item key OR
        // by a separate PhoneRegistry row — see the note below.)
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return row;
  } catch (err) {
    if (isConditionalFailure(err)) throw Object.assign(new Error("Rider already registered"), { status: 409 });
    throw err;
  }
}
```

> **Important:** the query-then-write above is still a TOCTOU for *phone* uniqueness, because DynamoDB has no unique constraint on a non-key attribute. If phone uniqueness must be truly enforced, make the phone the partition key of a dedicated registry row and write it transactionally:

```ts
await docClient().send(
  new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE.riders(), Item: riderRow, ConditionExpression: "attribute_not_exists(pk)" } },
      {
        Put: {
          TableName: TABLE.riders(),
          Item: { pk: `PHONE#${normalisedPhone}`, sk: "UNIQUE", riderId: riderRow.id, createdAt: new Date().toISOString() },
          ConditionExpression: "attribute_not_exists(pk)",   // ← this is the real uniqueness guard
        },
      },
    ],
  }),
);
```

**Trade-offs:**
- Adding a GSI costs write capacity on every rider write (small — riders change rarely) and a backfill of existing rows before the index is queryable.
- The `phone-index` is `KEYS_ONLY` deliberately: a rider's full record is fetched by primary key when needed, and the index exists solely to answer "does this phone exist". `ProjectionType: ALL` here would be the C-06 mistake again.
- The transactional registry row makes the phone immutable in practice — changing a rider's phone number requires a second transaction to move the registry row. Decide whether phone is mutable before choosing this design.
- **Existing duplicates:** the fix does not remove riders who already share a phone. Add a one-off script to detect and merge, or accept the ambiguity and only prevent new duplicates.

---

## C-06 · Five `ProjectionType: ALL` GSIs on `OrdersTable`

**Severity & Impact:** **FinOps** — every order write is billed as six writes; every status update is billed as six writes.

**Location:** `infra/serverless.yml:419-446`

```yaml
GlobalSecondaryIndexes:
  - IndexName: user-orders
    KeySchema: [{ AttributeName: userId, KeyType: HASH }, { AttributeName: createdAt, KeyType: RANGE }]
    Projection: { ProjectionType: ALL }
  - IndexName: restaurant-orders
    ... Projection: { ProjectionType: ALL }
  - IndexName: rider-orders
    ... Projection: { ProjectionType: ALL }
  - IndexName: status-board
    ... Projection: { ProjectionType: ALL }
  - IndexName: payment-status
    ... Projection: { ProjectionType: ALL }
```

**The Flaw:**
With `PAY_PER_REQUEST`, every write to the base table costs WCU proportional to the item size **plus one write per GSI**, each costing WCU proportional to the *projected* size. With `ALL` projection on five GSIs, all five copy the entire item:

- Base table write: 1 WRU × item size
- 5 × ALL-projection GSI write: 5 × item size

So an order write is billed at roughly **6× an un-indexed write**, and it *stays* 6× for every subsequent `UpdateItem` (each `setOrderStatus` on the money path is a 6× write). An order is updated ~6 times in its life (placed → preparing → ready → assigned → picked_up → delivered), so a 1 KB order costs ≈ 6 × 6 = 36 write units, versus 6 with no GSIs and ~12 with KEYS_ONLY projections where appropriate.

There is a second, harder cost: **`ALL` projections cannot be changed in place.** Switching to `KEYS_ONLY`/`INCLUDE` later requires creating a new index and backfilling it — a 5-index migration on the hottest table in the system. Doing it now is far cheaper than doing it at 10M orders.

And the correctness trap: `rider-orders` and `status-board` and `payment-status` are all keyed on attributes that are **absent on most orders** (`riderId` is null until assignment; `paymentStatus` is "pending" for a while). A `ProjectionType: ALL` index still writes a row for an item missing its key? **No** — DynamoDB writes a "sparse" index entry only when the key attributes exist. So orders with no `riderId` never enter `rider-orders`, which is the intended sparseness. That part is correct.

**The Fix:**
Project only what each access pattern returns. Reading each repository function tells exactly which attributes are needed:

```yaml
GlobalSecondaryIndexes:
  # listOrdersByUser / getMyOrders — renders a card: id, status, totals, restaurant name, time
  - IndexName: user-orders
    KeySchema: [{ AttributeName: userId, KeyType: HASH }, { AttributeName: createdAt, KeyType: RANGE }]
    Projection:
      ProjectionType: INCLUDE
      NonKeyAttributes: [status, paymentStatus, totalAmount, restaurantId, restaurantName, itemCount]

  # listOrdersByRestaurant / analytics — kitchen board
  - IndexName: restaurant-orders
    KeySchema: [{ AttributeName: restaurantId, KeyType: HASH }, { AttributeName: createdAt, KeyType: RANGE }]
    Projection:
      ProjectionType: INCLUDE
      NonKeyAttributes: [status, paymentStatus, totalAmount, userId, items, createdAt]

  # listDeliveredOrdersByRider / findCurrentOrderForRider
  - IndexName: rider-orders
    KeySchema: [{ AttributeName: riderId, KeyType: HASH }, { AttributeName: createdAt, KeyType: RANGE }]
    Projection:
      ProjectionType: INCLUDE
      NonKeyAttributes: [status, restaurantId, userId, totalAmount, deliveredAt, pickedUpAt]

  # listReadyOrders — the status-board feed
  - IndexName: status-board
    KeySchema: [{ AttributeName: status, KeyType: HASH }, { AttributeName: createdAt, KeyType: RANGE }]
    Projection:
      ProjectionType: INCLUDE
      NonKeyAttributes: [restaurantId, totalAmount, paymentStatus, deliveryAddress, items]

  # reconciliation — existence + age only
  - IndexName: payment-status
    KeySchema: [{ AttributeName: paymentStatus, KeyType: HASH }, { AttributeName: createdAt, KeyType: RANGE }]
    Projection: { ProjectionType: KEYS_ONLY }
```

**Trade-offs:**
- Every `NonKeyAttributes` list is a hard contract: if a handler starts returning an attribute not projected, the GSI query returns `undefined` for it, and the bug appears only on the indexed path (never in local tests against the base table). Add a type-level guard by keeping each list next to the function that queries that index.
- `INCLUDE` costs the same per-attribute as `ALL` if you end up including most attributes. Measure: if `NonKeyAttributes` exceeds ~60% of the item, `ALL` is cheaper operationally.
- `payment-status` → `KEYS_ONLY` is safe because reconciliation only needs `id` + `createdAt` + `paymentStatus` (all keys). Verify before switching: `reconciliation.ts` reads `candidate.id` and `candidate.paymentIntent`? If it reads `paymentIntent`, `KEYS_ONLY` breaks it — read the code before changing this one.
- **`ALL` cannot be modified in place.** This is a create-new-index + backfill + delete-old migration, done five times, on the busiest table. Plan it as a maintenance window with the app writing to both shapes, or accept the cost until the next schema change forces it.

---

## C-07 · Every list query in the repo is single-page — DynamoDB's 1 MB ceiling is silently a business limit

**Severity & Impact:** **Medium** — silent truncation. No error, no log, no partial marker. The API returns a *shorter list* and the client renders it as complete.

**Location:**
- `backend/restaurant-service/src/dynamo/cart.ts:35-44` (`getCartRows`)
- `backend/restaurant-service/src/dynamo/cart.ts:270-282` (`listMenuItemsByRestaurant`)
- `backend/restaurant-service/src/dynamo/cart.ts:373-388` (`listAddresses`)
- `packages/backend-common/src/dynamo/Order.ts:208-229` (`listDeliveredOrdersByRider`)
- `packages/backend-common/src/dynamo/Rider.ts:114-148` (`listAvailableRidersNear`)

```ts
// cart.ts — getCartRows: no Limit, no LastEvaluatedKey, no pagination contract
export async function getCartRows(userId: string): Promise<DynamoCartRow[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.carts(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": cartPk(userId) },
    }),
  );
  return (out.Items as DynamoCartRow[]) ?? [];   // ← LastEvaluatedKey discarded
}
```

```ts
// Rider.ts — the one that actually breaks
const out = await docClient().send(
  new QueryCommand({
    TableName: TABLE.riders(),
    IndexName: "verified-index",              // ← partition = isVerified (0 or 1)
    KeyConditionExpression: "isVerified = :v",
    FilterExpression: "isAvailable = :a AND lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon",
    // no Limit, no LastEvaluatedKey
  }),
);
```

**The Flaw:**
A DynamoDB `Query` returns at most 1 MB of items and then stops, setting `LastEvaluatedKey`. Nothing in this repository ever reads `LastEvaluatedKey`. Every list endpoint in the platform therefore degrades from "correct" to "arbitrarily truncated" at a size nobody chose.

Two of these matter for real:

1. **`listAvailableRidersNear` is the rider matcher.** Its partition key is `isVerified` — a numeric flag with exactly two possible values. Every verified rider in the country lives in **one partition**. At ~1 KB per rider row, the query page fills at ~1,000 riders and stops. Beyond that, riders who happen to sort later are **invisible to the matcher forever** — not "slow", not "approximate": absent. Orders in those areas never get assigned, `broadcast: true` fires, the order parks in the cross-time batching pool, and it dies there when the pool row TTL sweeps. The bug presents as "dispatch is flaky in some neighbourhoods", which is close to undebuggable from the dashboard.

2. **`listMenuItemsByRestaurant`** backs the customer-facing menu. A restaurant with a large menu plus image metadata will silently lose its tail items — the cheapest, most-ordered SKUs are usually last.

3. **`listDeliveredOrdersByRider`** sends `Limit: 50` *and* a `FilterExpression`. `Limit` is applied **before** the filter, so this returns "the delivered orders among your most recent 50 orders" — typically far fewer than 50. Rider earnings history under-reports and the rider has no way to tell the number is wrong.

**The Fix:**
Add one shared pagination helper and use it everywhere a list is returned to a client. Do **not** loop-to-exhaustion on the server for unbounded lists — that turns a slow query into a timeout; return a cursor instead.

```ts
// packages/backend-common/src/dynamo/paginate.ts
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { NativeAttributeValue } from "@aws-sdk/util-dynamodb";

export interface Page<T> {
  items: T[];
  /** Opaque cursor. Serialise/deserialise with Buffer JSON — DO NOT hand it to the client raw. */
  nextCursor: string | null;
}

export function encodeCursor(key: Record<string, NativeAttributeValue> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Record<string, AttributeValue> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // A malformed cursor must NOT silently restart from page 1 — that
    // produces duplicate rows in an infinite-scroll UI.
    throw Object.assign(new Error("Invalid cursor"), { status: 400 });
  }
}
```

```ts
// Rider.ts — the matcher, rewritten as a bounded, multi-cell query.
// (C-08 replaces the single-partition index entirely; this is the
// minimal correct version if you keep the current schema.)
export async function listAvailableRidersNear(
  lat: number, lon: number, radiusMeters = 10_000,
): Promise<DynamoRider[]> {
  const box = boundingBox(lat, lon, radiusMeters / 1000);
  const collected: DynamoRider[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

  // Cap the work: a matcher needs the ~N nearest, not the whole fleet.
  // 5 pages = ~5 MB ceiling, and we stop at 200 candidates anyway.
  for (let page = 0; page < 5; page += 1) {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLE.riders(),
        IndexName: "verified-index",
        KeyConditionExpression: "isVerified = :v",
        FilterExpression: "isAvailable = :a AND lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon",
        ExpressionAttributeValues: { ":v": 1, ":a": true, ":minLat": box.minLat, ":maxLat": box.maxLat, ":minLon": box.minLon, ":maxLon": box.maxLon },
        ExclusiveStartKey,
      }),
    );
    collected.push(...(((out.Items as Record<string, unknown>[]) ?? []).map((i) => toRider(i)!)));
    ExclusiveStartKey = out.LastEvaluatedKey;
    if (!ExclusiveStartKey || collected.length >= 200) break;
  }

  if (ExclusiveStartKey && collected.length < 200) {
    // Real capacity problem, not a normal stop — make it visible.
    console.warn(`[rider-matcher] truncated at ${collected.length} riders for ${lat},${lon}; geohash index needed`);
  }

  return collected
    .map((r) => ({ rider: r, distance: distanceMeters([lon, lat], r.location.coordinates) }))
    .filter((x) => x.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .map((x) => x.rider);
}
```

```ts
// cart.ts — cursor contract for the client-facing lists
export async function listMenuItemsByRestaurant(
  restaurantId: string,
  cursor?: string,
  limit = 100,
): Promise<Page<DynamoMenuItem>> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.menuItems(),
      IndexName: "restaurant-index",
      KeyConditionExpression: "restaurantId = :r",
      ExpressionAttributeValues: { ":r": restaurantId },
      Limit: limit,
      ExclusiveStartKey: decodeCursor(cursor),
    }),
  );
  return {
    items: (((out.Items as Record<string, unknown>[]) ?? []).map((i) => toMenuItem(i)!)),
    nextCursor: encodeCursor(out.LastEvaluatedKey as never),
  };
}
```

Then in the controller, return `{ items, nextCursor }` and — critically — **break the response shape deliberately**. A client that ignores `nextCursor` today gets the old behaviour (first page only), which is what it already has.

For `listDeliveredOrdersByRider`, invert the design instead of paginating it: the `rider-orders` GSI already sorts by `createdAt`, so put the filter in the *key*. Since a rider's delivered orders are a contiguous-ish tail of their history, fetch descending and stop once you have `limit` matches, with a page cap:

```ts
// Collect across pages until `limit` matches are found — Limit now means
// "50 delivered orders", not "delivered orders among 50 arbitrary ones".
export async function listDeliveredOrdersByRider(riderId: string, limit = 50): Promise<DynamoOrder[]> {
  const found: DynamoOrder[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

  for (let page = 0; page < 4 && found.length < limit; page += 1) {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLE.orders(),
        IndexName: "rider-orders",
        KeyConditionExpression: "riderId = :r",
        FilterExpression: "paymentStatus = :paid AND #s = :delivered",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":r": riderId, ":paid": "paid", ":delivered": "delivered" },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }),
    );
    found.push(...((out.Items as DynamoOrder[]) ?? []));
    ExclusiveStartKey = out.LastEvaluatedKey;
    if (!ExclusiveStartKey) break;
  }
  return found.slice(0, limit);
}
```

**Trade-offs:**
- Every client caller must learn `nextCursor`. For `getCartRows` and `listAddresses` that is pure ceremony — a cart or address book cannot reach 1 MB. Apply the helper where the list is genuinely unbounded (menu, riders, order history) and leave the bounded ones with an explicit comment saying *why* they are unbounded, so the next reader does not "fix" it.
- The rider matcher now does up to 5 round-trips instead of 1 when the fleet is large — slower than a correct index and still wrong. It is a stopgap; C-08 is the real fix.
- `base64url` cursors are opaque but trivially decodable. They leak key attribute values only, which the client already knows. Do **not** put authorisation state in a cursor.
- `Buffer.from` in a Lambda with a shared `docClient` is free; but if you ever move this to the edge runtime, `Buffer` is absent — use `TextEncoder`/`btoa` there.

---

## C-08 · Rider/order matching is a single hot partition plus in-memory haversine

**Severity & Impact:** **High** — this is the throughput ceiling of the whole dispatch system, and it fails by silently returning fewer riders, not by erroring.

**Location:**
- `infra/serverless.yml:384-397` — `RidersTable.verified-index`, `KeySchema: isVerified → HASH`, `Projection: ALL`
- `infra/serverless.yml:359-372` — `UsersTable.verified-index`, identical shape
- `packages/backend-common/src/dynamo/Rider.ts:114-148`
- `packages/backend-common/src/dynamo/Order.ts:255-269` (`listReadyOrders`)

```yaml
- IndexName: verified-index
  KeySchema:
    - { AttributeName: isVerified, KeyType: HASH }   # ← two values, platform-wide
  Projection: { ProjectionType: ALL }
```

```ts
// Order.ts — "give me the ready orders" = a city-wide scan of one partition
export async function listReadyOrders(limit = 100) {
  const out = await docClient().send(new QueryCommand({
    TableName: TABLE.orders(),
    IndexName: "status-board",
    KeyConditionExpression: "#s = :ready",
    FilterExpression: "paymentStatus = :paid",
    Limit: limit,
  }));
```

**The Flaw:**
Both matchers are built on a **low-cardinality partition key**, which is the canonical DynamoDB anti-pattern:

- `verified-index` partitions on `isVerified` ∈ `{0, 1}`. All verified riders — every city, every state — share **one** partition, capped at 3,000 RCU / 1,000 WCU with `PAY_PER_REQUEST` auto-scaling only *within* that partition's ceiling. Every rider status/location update writes into that partition. Every matcher call reads from it.
- `status-board` partitions on `status`. Every `ready_for_rider` order, platform-wide, shares one partition. `listReadyOrders(200)` pulls 200 of them and then `fetchAvailableOrders` throws almost all of them away because they belong to a different city.
- `ProjectionType: ALL` on `verified-index` means **every rider write is billed twice**, including the location heartbeat.

Do the arithmetic on a modest 300-rider, 3-city operation:
- Location heartbeat every 5 s (`rider-service`) → 60 writes/rider/minute → 300 × 60 = **18,000 writes/min into a single partition**. Item ~1 KB, and `ALL`-projection → 2 WRU each → **36,000 WRU/min ≈ 600 WCU sustained, on one partition.** The partition autoscales to 1,000 WCU and then throttles. It is not a scaling story; it is a wall.
- Each matcher invocation reads the *entire* partition page and haversines every rider in JS. `boundingBox` bounds the DB read, but the filter is applied post-read, so you pay to read and then throw away ~95% of the bytes.

**The Fix:**
Partition geographically. A geohash cell is a string prefix that is stable, indexable, and — crucially — a *write-side* decision, so reads never need a post-filter:

```ts
// packages/backend-common/src/aws/geohash.ts
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash encode. 5 chars ≈ 4.9 km × 4.9 km, 6 chars ≈ 1.2 km × 0.6 km. */
export function geohash(lat: number, lon: number, precision = 5): string {
  let idx = 0, bit = 0, evenBit = true, hash = "";
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (minLon + maxLon) / 2;
      if (lon >= mid) { idx = idx * 2 + 1; minLon = mid; } else { idx = idx * 2; maxLon = mid; }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; minLat = mid; } else { idx = idx * 2; maxLat = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { hash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

/** The cell plus its 8 neighbours, deduped. 9 cells ≈ covers a ~10 km radius at precision 5. */
export function coveringCells(lat: number, lon: number, precision = 5, ring = 1): string[] {
  const centre = geohash(lat, lon, precision);
  // ... expand by `ring` using the geohash neighbour table
}
```

Schema change:

```yaml
# infra/serverless.yml — RidersTable
AttributeDefinitions:
  - { AttributeName: pk, AttributeType: S }
  - { AttributeName: sk, AttributeType: S }
  - { AttributeName: userId, AttributeType: S }
  - { AttributeName: geoCell, AttributeType: S }        # e.g. "tdr1v"
  - { AttributeName: available, AttributeType: S }      # "1" when available, REMOVED when not
GlobalSecondaryIndexes:
  - IndexName: user-index
    KeySchema: [{ AttributeName: userId, KeyType: HASH }]
    Projection: { ProjectionType: KEYS_ONLY }           # ← C-06 lesson

  # Sparse: an attribute is deleted (not set to false) when the rider goes
  # offline, which removes the row from the index entirely. No filter needed.
  - IndexName: geo-index
    KeySchema:
      - { AttributeName: geoCell, KeyType: HASH }
      - { AttributeName: available, KeyType: RANGE }
    Projection:
      ProjectionType: INCLUDE
      NonKeyAttributes: [userId, location, rating, vehicleType, activeOrderId]

  # Keep verified-index ONLY for "is this rider verified" admin lookups — never for matching.
  - IndexName: verified-index
    KeySchema: [{ AttributeName: isVerified, KeyType: HASH }]
    Projection: { ProjectionType: KEYS_ONLY }
```

Writer side — one extra line on the existing heartbeat:

```ts
// Rider.ts — updateRiderLocation
await docClient().send(new UpdateCommand({
  TableName: TABLE.riders(),
  Key: { pk: riderPk(riderId), sk: RIDER_SK },
  UpdateExpression:
    "SET #loc = :loc, lat = :lat, lon = :lon, geoCell = :cell, updatedAt = :now " +
    (available ? "SET available = :one" : "REMOVE available"),
  ExpressionAttributeNames: { "#loc": "location" },
  ExpressionAttributeValues: { ":loc": {...}, ":lat": lat, ":lon": lon, ":cell": geohash(lat, lon), ":one": "1", ":now": new Date().toISOString() },
}));
```

Reader side — a `Query` per cell, no `FilterExpression`, 9 cells in parallel:

```ts
export async function listAvailableRidersNear(lat: number, lon: number, radiusMeters = 10_000): Promise<DynamoRider[]> {
  const cells = coveringCells(lat, lon, 5, 1);

  const pages = await Promise.all(
    cells.map((cell) =>
      docClient().send(new QueryCommand({
        TableName: TABLE.riders(),
        IndexName: "geo-index",
        KeyConditionExpression: "geoCell = :c AND available = :one",
        ExpressionAttributeValues: { ":c": cell, ":one": "1" },
        Limit: 50,   // ← per cell; a 10 km cell never holds 50 free riders in practice
      })),
    ),
  );

  return pages
    .flatMap((p) => ((p.Items as Record<string, unknown>[]) ?? []).map((i) => toRider(i)!))
    .map((r) => ({ rider: r, distance: distanceMeters([lon, lat], r.location.coordinates) }))
    .filter((x) => x.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .map((x) => x.rider);
}
```

And for `listReadyOrders`, flip the access pattern from "all ready orders, filtered by city in memory" to "ready orders per restaurant", because `fetchAvailableOrders` already knows the restaurants it cares about:

```yaml
# OrdersTable — replaces status-board for the matcher
- IndexName: restaurant-status
  KeySchema:
    - { AttributeName: restaurantId, KeyType: HASH }
    - { AttributeName: createdAt, KeyType: RANGE }
  Projection:
    ProjectionType: INCLUDE
    NonKeyAttributes: [status, paymentStatus, restaurantLocation, totalAmount, deliveryAddress]
```

**Trade-offs:**
- **Geohash boundary effects.** A rider 20 m across a cell edge appears in a neighbouring cell you queried — fine when you query the 9-cell ring, *broken* if you ever query a single cell. The neighbour table must be correct; test it at the equator, at a cell corner, and near ±180° longitude (where wraparound bites).
- Precision 5 is chosen for a ~10 km radius. If the radius becomes configurable, precision must become a function of the radius or you will query 9 cells to cover 5 km and 9 cells to cover 50 km and get the wrong answer for one of them.
- Backfill: every existing rider needs `geoCell` and `available` written before the GSI serves traffic. Plan it as a scripted `Scan` + batched `UpdateItem` (this is one of the few legitimate full-table scans in the system).
- Two writes per heartbeat instead of one is **not** the outcome — it is the same single `UpdateItem`, now also setting `geoCell`. The cost *drops*, because `verified-index` goes to `KEYS_ONLY`.
- The 9 parallel `Query` calls cost 9 RCU minimums rather than 1, so a *tiny* fleet gets slightly more expensive. At 300 riders the difference is unmeasurable next to the removed hot partition.
- Sparse membership means "available" must be `REMOVE`d, not set to `"0"`. Any code that writes `available = false` will leave the rider permanently in the index and the matcher will hand out orders to offline riders. Find every writer of `isAvailable` before shipping this.

---

## C-09 · Cancellation publishes four realtime events sequentially, and re-reads the restaurant each time

**Severity & Impact:** **Medium** — latency on a user-visible action, plus four serialised DynamoDB reads where zero are needed.

**Location:**
- `backend/restaurant-service/src/controllers/order.ts:515-534`
- `backend/restaurant-service/src/controllers/order.ts:420-431` (the batch helper that already exists)
- `backend/rider-service/src/controllers/consumers.ts` (`emitAssignedRealtime`, `emitStatusRealtime`, `emitDeliveredRealtime`)

```ts
// order.ts:515-534 — one await per recipient, one by one
await publishRealtime(restaurantRoom, "order:cancelled", payload);
await publishRealtime(`user:${order.userId}`, "order:cancelled", payload);
if (order.riderId) await publishRealtime(`user:${order.riderId}`, "order:cancelled", payload);
await publishRealtime("admin:dispatch", "order:cancelled", payload);
```

**The Flaw:**
`publishRealtimeBatch` is defined twenty lines above this call site (line 420) and used by the assignment path. Cancellation — the more latency-sensitive path, because the customer is staring at a spinner — was written as four sequential `await`s. Each is a full SNS publish with its own TCP round-trip on a cold client.

Compounding it, the rider-service consumers each do:

```ts
const restaurant = await getRestaurantById(order.restaurantId);   // per event
```

`getRestaurantById` is a `GetItem` whose only use is to name a room. The room name is `restaurant:${order.restaurantId}` — **it does not need the restaurant record at all.** This is a read that exists because it was easier to copy than to think, and it costs one DynamoDB read per realtime event, on the hot path.

There is also a latent correctness bug in the same area: `signAccessToken` never includes `restaurantId`, so `handleConnect`'s `if (userData.restaurantId)` branch never fires and the `restaurant:<id>` room is **never joined by anyone**. All four cancels above publish into rooms with zero members (see B-13 / known-gaps §1.2).

**The Fix:**

```ts
// order.ts — one publish, four recipients
await publishRealtimeBatch([
  { room: restaurantRoom,               event: "order:cancelled", payload },
  { room: `user:${order.userId}`,       event: "order:cancelled", payload },
  ...(order.riderId ? [{ room: `user:${order.riderId}`, event: "order:cancelled" as const, payload }] : []),
  { room: "admin:dispatch",             event: "order:cancelled", payload },
]);
```

```ts
// consumers.ts — drop the read entirely
const emitStatusRealtime = async (order: DynamoOrder, status: string) => {
  // The room is derived from the id we already hold. No lookup required.
  await publishRealtimeBatch([
    { room: `user:${order.userId}`,              event: "order:status", payload: { orderId: order.id, status } },
    { room: `restaurant:${order.restaurantId}`,  event: "order:status", payload: { orderId: order.id, status } },
  ]);
};
```

Then fix the room-join gap so the publishes actually land — include `restaurantId` in the access token at sign time (see B-13's fix for the token, and note that adding a claim to `signAccessToken` requires the authorizer and every `isAuth` variant to keep ignoring unknown claims, which they already do).

**Trade-offs:**
- `publishRealtimeBatch` sends up to 10 entries per `PublishBatch` call. If four rooms happen to need 11 messages, it chunks — that is handled. But `PublishBatch` is **all-or-nothing per entry in `Failed`**, so the helper must log `out.Failed`, or a partial failure is invisible. Verify `messaging.ts:60-120` does this; if it only checks the promise resolving, the batch is weaker than the sequential version it replaced.
- Removing the `getRestaurantById` read removes a source of truth for `payload.restaurantName`. If any realtime consumer *renders* that name, it must move to the client's own restaurant fetch. Check the frontend socket handlers before deleting.
- Adding `restaurantId` to the token changes a security-relevant payload. A seller whose restaurant assignment changes will keep broadcasting into the old room until their token refreshes (≤15 min). Acceptable, but it must be documented because it is a cross-tenant leak window.

---

## C-10 · `sendWorkItem` never batches, and its 64 KB cost warning is inert

**Severity & Impact:** **FinOps + Medium** — billed requests you did not need, and a payload-size guard that cannot fire.

**Location:** `packages/backend-common/src/aws/messaging.ts:157-203`

```ts
const SQS_CHUNK_BYTES = 64 * 1024;
const SQS_MAX_BYTES = 256 * 1024;

export async function sendWorkItem(queueUrl: string, type: string, data: unknown): Promise<void> {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > SQS_MAX_BYTES) throw new Error(/* 256 KB */);
  if (bytes > SQS_CHUNK_BYTES) {
    console.warn(`SQS body for ${type} is ${bytes} B — crosses the 64 KB billing boundary`);
    // ← and then sends it anyway
  }
  await getSqs().send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageAttributes: {...} }));
}
```

**The Flaw:**
Two things:

1. **No batch API.** SQS bills per request, and `SendMessageBatch` carries **10 messages for the price of one request** (up to 256 KB total). The rider matcher already fans out to many riders (`publishFanoutBatch` uses `PublishBatch` for SNS — line 60-120) but the *work* queue path sends one message per call. Every place that enqueues N work items pays N requests where 1 would do.

2. **The 64 KB warning is a no-op.** The comment above it explains correctly that "SQS meters a request per 64 KB of payload, so crossing that line silently doubles the billed requests". Then the code logs a warning and sends. The condition is detectable, the remedy is known, and the code does nothing. This is worse than no check, because the comment tells a reader the risk is handled.

**The Fix:**

```ts
// messaging.ts
export interface WorkItem { type: string; data: unknown; }

const SQS_BATCH_MAX = 10;
const SQS_BATCH_BYTES = 256 * 1024;

/** Batch enqueue. Chunks by count AND cumulative bytes — SQS rejects a batch over 256 KB total. */
export async function sendWorkItems(queueUrl: string, items: WorkItem[]): Promise<void> {
  const chunks: WorkItem[][] = [];
  let current: WorkItem[] = [];
  let bytes = 0;

  for (const item of items) {
    const body = JSON.stringify({ type: item.type, data: item.data });
    const size = Buffer.byteLength(body, "utf8");
    if (size > SQS_CHUNK_BYTES) {
      // The claim-check boundary. Send the reference, not the payload.
      throw new Error(
        `Work item ${item.type} is ${size} B — over the 64 KB billing boundary. ` +
        `Store it (S3/Cloudinary) and enqueue the reference (see dispute.ts photoUrl).`,
      );
    }
    if (current.length === SQS_BATCH_MAX || bytes + size > SQS_BATCH_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ ...item, _size: size } as never);
    bytes += size;
  }
  if (current.length) chunks.push(current);

  for (const chunk of chunks) {
    const out = await getSqs().send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((item, i) => ({
          Id: String(i),
          MessageBody: JSON.stringify({ type: item.type, data: item.data }),
          MessageAttributes: { type: { DataType: "String", StringValue: item.type } },
        })),
      }),
    );

    // Partial failure is the default mode of SendMessageBatch — a resolved
    // promise means the *request* succeeded, not the messages.
    const failed = out?.Failed ?? [];
    if (failed.length) {
      throw new Error(
        `SQS batch partial failure on ${queueUrl}: ${failed.map((f) => `${f.Code}:${f.Message}`).join("; ")}`,
      );
    }
  }
}

/** Keep the single-item ergonomics without duplicating the size guard. */
export async function sendWorkItem(queueUrl: string, type: string, data: unknown): Promise<void> {
  await sendWorkItems(queueUrl, [{ type, data }]);
}
```

**Trade-offs:**
- Partial failure semantics change. Today a failed `SendMessage` throws and the caller aborts. With batching, some messages land and some do not; throwing means the caller retries **all** of them, duplicating the ones that succeeded. Either accept that (the payment consumer is idempotent via `claimOrderForPayment`) or split `Failed` back out per queue. Do not silently swallow `Failed`.
- Chunking by cumulative bytes requires the serialised body to be built twice (once to measure, once to send) unless you cache it. Under 256 KB the cost is trivial; keep it simple.
- Promoting the 64 KB warning to a throw is a **breaking change** for any current caller over 64 KB. Enumerate them first (`grep -rn "sendWorkItem" backend/`) and either move them to the claim-check pattern or add a temporary `allowOversize` flag with a deprecation TODO.
- `SendMessageBatch` has a 256 KB *total*, not per-message, so a single 200 KB message cannot share a batch with a 100 KB one. The chunker above handles it, but it means one oversized message forces a solo request — batching only helps for many small messages, which is exactly the fan-out case.

---

## C-11 · `makeDomainEventPublisher`'s timeout parameter is dead, which breaks the rider rollback

**Severity & Impact:** **High** — a hung SNS call turns a correct compensating saga into a stranded order.

**Location:**
- `packages/backend-common/src/aws/messaging.ts:130-155`
- `backend/rider-service/src/controllers/consumers.ts` (the accept-order flow that relies on `false`)

```ts
export function makeDomainEventPublisher() {
  return async (event: string, payload: unknown, _timeoutMs = 5000): Promise<boolean> => {
    try {
      await getSns().send(new PublishCommand({ /* ... */ }));
      return true;
    } catch (error) {
      console.error(`[events] publish failed for ${event}`, error);
      return false;
    }
  };
}
```

```ts
const getSns = () => (snsClient ??= new SNSClient({ maxAttempts: 3 }));   // no requestHandler, no timeouts
```

**The Flaw:**
`_timeoutMs` is underscore-prefixed and never read. The publisher's contract — as used by rider-service — is:

```ts
const ok = await publishRiderEvent("rider.order_accepted", payload);
if (!ok) {
  await releaseRiderFromOrder(order.id, riderId);   // compensate: give the rider back
  return { status: "rejected" };                    // tell the rider to try again
}
```

That compensation is correct **only if `publishRiderEvent` returns**. With no `requestTimeout` on the SNS client, the AWS SDK's default is to wait for the socket's natural timeout. The Lambda has `timeout: 15` (provider-level). So the real sequence under an SNS control-plane stall is:

1. `claimRiderForOrder` succeeds — the rider is now assigned in DynamoDB.
2. `publishRiderEvent` hangs.
3. Lambda times out at 15 s and is killed.
4. `releaseRiderFromOrder` **never runs**.
5. The rider's app sees no response, shows "try again", and the rider is stuck `unavailable` on an order nobody knows is assigned to them.

`maxAttempts: 3` makes it worse, not better: three attempts with the SDK's default exponential backoff easily exceeds 15 s on its own.

This is the single most instructive flaw in the repo, because the *design* is right — a compensating action — and it is defeated by a missing client timeout. Sagas need bounded steps more than they need compensations.

**The Fix:**

```ts
// messaging.ts
import { NodeHttpHandler } from "@smithy/node-http-handler";

const snsClient = (() => {
  // 1 s to connect, 4 s for the whole request. With maxAttempts: 2 that
  // bounds the worst case at ~10 s, inside every caller's Lambda timeout.
  const requestHandler = new NodeHttpHandler({
    connectionTimeout: 1_000,
    requestTimeout: 4_000,
  });
  return new SNSClient({ maxAttempts: 2, retryMode: "adaptive", requestHandler });
})();

export function makeDomainEventPublisher() {
  return async (event: string, payload: unknown, timeoutMs = 5_000): Promise<boolean> => {
    const controller = new AbortController();
    // Belt AND braces: the AbortController is the guarantee, the request
    // handler is the fast path. Never rely on the handler alone — a DNS
    // stall can bypass it.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await snsClient.send(
        new PublishCommand({
          TopicArn: EVENTS_TOPIC_ARN,
          Message: JSON.stringify({ event, data: payload }),
          MessageAttributes: { event: { DataType: "String", StringValue: event } },
        }),
        { abortSignal: controller.signal },
      );
      return true;
    } catch (error) {
      console.error(`[events] publish failed for ${event} after ${timeoutMs}ms`, error);
      return false;   // ← the caller's compensation now actually runs
    } finally {
      clearTimeout(timer);
    }
  };
}
```

Apply the same `requestHandler` to `getSqs()` and to every provider client — `utils-service` calling Razorpay/Stripe, `restaurant-service` calling the AI tier. A client with no `requestTimeout` is a client that can consume an entire Lambda budget.

**Trade-offs:**
- A 5 s publish budget means a genuinely slow SNS call now *fails* where it used to *succeed late*. On the accept path that produces a spurious rollback: the order event is published, the rollback runs, and the rider is released even though the order service saw the acceptance. This is why the compensating action must itself be idempotent — `releaseRiderFromOrder` must be conditional on the assignment still being this rider's, and the consumer must tolerate a later `rider.order_accepted` for an order it already released.
- `retryMode: "adaptive"` adds client-side rate limiting that can *delay* rather than fail fast. Pair it with the `AbortController`, which is what actually enforces the bound.
- `NodeHttpHandler` pins you to the Node runtime. Both runtimes here are Node, so it is free today; it is a portability note, not a cost.
- After this fix, `publishRiderEvent` can return `false` in situations that used to hang into a Lambda timeout — meaning `releaseRiderFromOrder` will start running in production for the first time. Make sure it is tested, because dead code that suddenly activates is a classic outage.

---

## C-12 · The client polls five screens on timers, overrides the cache default, and never uses `ETag`

**Severity & Impact:** **FinOps + Medium** — every open tab is a metered request stream into the shared HTTP API, the authorizer Lambda, and DynamoDB.

**Location:**
- `apps/web/src/features/orders/api/index.ts:84-89` — 2 s payment poll, `staleTime: 0`
- `apps/web/src/features/rider/api/index.ts:69, :91` — 15 s, twice
- `apps/web/src/features/dispatch/api/index.ts:53-54` — 15 s snapshot, `staleTime: 0`
- `apps/web/src/features/disputes/api/index.ts:124-129`, `:192-193` — 4 s / 20 s, `staleTime: 0`
- `apps/web/src/features/verification/api/index.ts:79` — `staleTime: 0`
- `apps/web/src/providers/query-provider.tsx:17` — the sensible global default being overridden

```ts
// providers/query-provider.tsx
staleTime: 1000 * 60 * 2, // 2 minutes  ← correct default

// features/orders/api/index.ts
refetchInterval: (query) => query.state.data?.paymentStatus === "paid" ? false : 2000,
refetchIntervalInBackground: false,      // ← good
staleTime: 0,                            // ← defeats the default above
```

**The Flaw:**
Three separate problems, each individually defensible and jointly expensive:

1. **`staleTime: 0` is applied per-query on the polling screens**, which cancels the 2-minute global default for exactly the queries that poll hardest. With `staleTime: 0`, every component mount, every route change, and every remount re-fires the request — on top of the interval. A user navigating between an order and the disputes list refetches both, immediately. The `refetchInterval` result is also *instantly stale*, so any component that mounts for a second opinion triggers a parallel request inside the same second.

2. **The 2 s payment poll is the worst-case shape.** 30 requests/minute/tab. Each one traverses CloudFront → HTTP API → **the authorizer Lambda (see D-02: `AuthorizerResultTtlInSeconds: 0`, so this is a second Lambda invocation per request)** → restaurant-service → DynamoDB. So one open checkout tab burns 60 Lambda invocations and 30 DynamoDB reads per minute. Even though `refetchIntervalInBackground: false` correctly pauses it on a hidden tab, a user who leaves the tab *visible* on a second monitor polls all day.

3. **Zero conditional-request support.** `grep -r "ETag\|If-None-Match"` over `apps/web/src` returns nothing, and no handler in any service sets `ETag`. Every poll returns a full JSON body and a 200, even when nothing changed — which is the overwhelming majority of polls, because a payment confirmation is one transition in a multi-minute window.

**The Fix:**
Layer three cheap changes. None of them requires a new service.

**a) Raise the interval and let the socket do the fast path.** The realtime channel already exists and already carries `order:status` and `payment` events; polling is a fallback, not the primary transport.

```ts
// features/orders/api/index.ts — polling is the FALLBACK
export const useOrderPolling = (orderId: string) =>
  useQuery({
    queryKey: ["order", orderId],
    queryFn: () => api.get(`/order/${orderId}`).then((r) => r.data),
    enabled: !!orderId,
    // Socket events invalidate this key the moment the webhook lands
    // (see useOrderSocket). 10 s is the safety net for a dropped socket,
    // not the mechanism.
    refetchInterval: (query) => (query.state.data?.paymentStatus === "paid" ? false : 10_000),
    refetchIntervalInBackground: false,
    staleTime: 8_000,             // < interval, so the interval is not fighting the cache
    placeholderData: keepPreviousData,
  });
```

```ts
// hooks/use-order-socket.ts — the primary path
useEffect(() => {
  const off = onSocketEvent("order:status", (e) => {
    queryClient.setQueryData(["order", e.orderId], (prev: Order | undefined) =>
      prev ? { ...prev, status: e.status } : prev,
    );
    if (e.status === "paid" || e.status === "placed") {
      void queryClient.invalidateQueries({ queryKey: ["order", e.orderId] });
    }
  });
  socket.trackOrder(orderId);
  return () => { off(); socket.untrackOrder(orderId); };
}, [orderId, queryClient]);
```

**b) Stop overriding `staleTime` to zero.** Delete the six `staleTime: 0` lines. Where a screen genuinely must be fresh on mount, the correct tool is `refetchOnMount: "always"`, which is explicit and does not disable caching for the query's other consumers.

**c) Conditional requests.** Return `ETag` from the read endpoints and honour `If-None-Match`:

```ts
// restaurant-service — a tiny revalidating read helper
export async function revalidatingJson(req: Request, res: Response, body: unknown, version: string) {
  const etag = `W/"${version}"`;   // e.g. `${order.updatedAt}`
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();   // no body, ~5× cheaper on the wire
  }
  return res.status(200).json(body);
}
```

```ts
// lib/api-client.ts — echo the ETag back automatically
api.interceptors.request.use((config) => {
  const cached = etagCache.get(config.url ?? "");
  if (cached && config.method === "get") {
    config.headers = { ...config.headers, "If-None-Match": cached };
  }
  return config;
});
api.interceptors.response.use(
  (res) => {
    const tag = res.headers["etag"];
    if (tag && res.config.url) etagCache.set(res.config.url, tag);
    if (res.status === 304) return { ...res, data: etagCache.body(res.config.url!) };
    return res;
  },
  (err) => Promise.reject(err),
);
```

**Trade-offs:**
- **`304` saves bandwidth, not request count.** The request still traverses CloudFront → API Gateway → authorizer → Lambda → DynamoDB. It is worth doing because CloudFront's data-transfer component is the metered part and mobile networks in the target market (INR pricing, `ap-south-1`) are the constraint — but be honest in the doc that it does not reduce Lambda invocations. Only raising the interval does that.
- Socket-driven invalidation makes the UI dependent on socket liveness. B-13's stale-token loop means the socket is **currently unreliable past 15 minutes**, so shipping (a) before fixing B-13 would make the order screen feel broken. Fix B-13 first, or keep the interval at 2 s until it is fixed.
- `304` responses must not be cached by CloudFront. The `/api/*` behaviour uses `Managed-CachingDisabled`, which is correct already — verify it stays that way, because enabling caching on `/api/*` would serve one user's order to another.
- `etagCache` is an in-memory `Map`; it must be keyed by URL **including query string** and must be invalidated on mutation. A naive `Map<url, etag>` sends `If-None-Match` for a resource the user just mutated and gets a stale `304`.

---

## C-13 · The SNS envelope is unwrapped by hand in two services, while the shared helper sits unused

**Severity & Impact:** **Medium** — duplicated protocol logic with no contract test; a change to the envelope shape breaks both copies independently.

**Location:**
- `backend/rider-service/src/config/consumers.ts:22-33` (`unwrapSnsEnvelope`)
- `backend/restaurant-service/src/config/consumers.ts:84-96` (`unwrapSnsEnvelope`, byte-for-byte copy)
- `packages/backend-common/src/aws/messaging.ts:265-309` (`toSqsShape`, `handlePushBatch` — exported, unused by these two)

```ts
// rider-service/config/consumers.ts
const unwrapSnsEnvelope = (record: any): { event: string; room?: string } => {
  // hand-rolled; parses record.Sns.Message or record.body, tolerates both
};
export const riderEventsHandler = async (event: any) =>
  handleSqsBatch(event, async (_data, raw) => {
    const envelope = unwrapSnsEnvelope(raw);
    if (!envelope?.event) return;
    // ...
  });
```

**The Flaw:**
`messaging.ts` already exports `toSqsShape` (normalises an SNS notification *or* an SQS batch into a uniform `{ body, attributes }` list) and `handlePushBatch` (which additionally rethrows the right exception for SNS-triggered Lambdas so the subscription retries). Both exist precisely to remove this duplication. Instead the same ~12-line parser is copy-pasted into two services and maintained independently.

Consequences:
- An envelope change (adding a `traceId`, changing `room` to `rooms`) must be made in three places, and nothing fails if you miss one. This is the definition of a distributed monolith.
- Neither copy has a test. There is no fixture asserting the shape of what `publishOrderEvent` produces versus what the consumers expect. The contract lives in two `any`-typed functions.
- `handleSqsBatch` is used here rather than `handlePushBatch`, so the SNS-specific retry semantics are lost: when a handler returns `batchItemFailures` for an SNS-sourced record, `handlePushBatch` converts it into a thrown error (which is what makes SNS/DLQ redeliver), whereas `handleSqsBatch` just returns the structure.

**The Fix:**
Delete both copies.

```ts
// rider-service/config/consumers.ts
import { handlePushBatch } from "@foodo/backend-common/aws/messaging";

export const riderEventsHandler = async (event: unknown) =>
  handlePushBatch(event, async (records) => {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of records) {
      try {
        const envelope = JSON.parse(record.body) as { event?: string; room?: string; data?: unknown };
        if (!envelope.event) continue;              // not ours — skip, do not fail
        await route(envelope);
      } catch (err) {
        console.error("[rider-events] failed", { event: (err as Error)?.message });
        failures.push({ itemIdentifier: record.id });
      }
    }
    return { batchItemFailures: failures };
  });
```

Then add the repo's first contract test, in `packages/backend-common/src/aws/messaging.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeFanoutPublisher } from "./messaging";

describe("fanout envelope", () => {
  it("round-trips publisher output through handlePushBatch's shape", async () => {
    const captured: unknown[] = [];
    const publish = makeFanoutPublisher({ send: async (cmd) => { captured.push(cmd.input); } } as never);
    await publish([{ room: "order:1", event: "order:status", payload: { status: "ready" } }]);

    const [input] = captured as { Message: string }[];
    const parsed = JSON.parse(input.Message);
    expect(parsed).toMatchObject({ event: "order:status", room: "order:1", data: { status: "ready" } });
  });
});
```

**Trade-offs:**
- `handlePushBatch` requires an injected SNS/SQS-shaped event; the two hand-rolled parsers were `any`-tolerant and silently ignored garbage. The typed version still ignores unknown records (`continue`), so behaviour is preserved — but the *JSON.parse* is now in a `try` and a malformed body counts as a failure rather than a silent skip. That is the right trade (a poison message should reach the DLQ, not vanish), but it will surface formerly-hidden malformed messages on the first deploy. Watch the DLQ depth for a day.
- Adding a test infrastructure to a package that currently has none is a real (small) cost: a `vitest` config, a `test` script, and wiring into turbo. Worth it — this is the only place the platform's cross-service event contract can be asserted.
- Do not add a JSON-schema validator here. It looks tempting and is a trap: the envelope carries a `payload` whose shape differs per event, so a schema would have to be a union of every event, which is exactly the coupling you removed.

---

## C-14 · `dispatch_service` health counters are per-container, so the dashboard reports fiction

**Severity & Impact:** **Medium** — an operations signal that is structurally incapable of being correct, presented as truth.

**Location:**
- `backend/ai-dispatch/app/services/dispatch_service.py:53` (`self.health = DispatchHealth()`)
- `:134, :158, :160` (counter increments)
- `:299` (`{"health": self.health.model_dump(), "pending_pool": pool_rows}`)
- `backend/ai-dispatch/app/api/routes.py` → served at `GET /api/dispatch/snapshot`, consumed by the admin dispatch page

```python
class DispatchService:
    def __init__(self, platform: PlatformClient):
        self.platform = platform
        self._graph = build_graph()
        self._llm = None
        self.health = DispatchHealth()      # ← module-level singleton, per container
```

```python
def get_service() -> DispatchService:
    """Warm-container singleton — one graph + client set per Lambda env."""
    global _service
    if _service is None:
        _service = DispatchService(PlatformClient())
    return _service
```

**The Flaw:**
`self.health` increments inside a singleton that lives in one Lambda container's memory. With 20 concurrent `dispatchConsumer` containers, 20 independent counters exist. `GET /api/dispatch/snapshot` runs on a **different** function (`http`), in a different container, whose singleton has seen zero events. So the dashboard's `orders_dispatched` reads `0` while the swarm is dispatching hundreds of orders — or, worse, reads a small number that looks plausible.

The tests assert on `service.health.orders_dispatched == 1`, so the field is *tested* and therefore *believed*. The tests pass because they call `handle_event` in-process on the same singleton — precisely the assumption that is false in production.

This is a category of bug worth naming: **a counter that is correct in the test harness and meaningless in the deployment.** It is worse than no metric, because it occupies the mental slot where a real metric should be.

**The Fix:**
Emit a CloudWatch metric from the process that does the work, using Embedded Metric Format — no extra API call, no latency, no IAM beyond `cloudwatch:PutMetricData` (which logs already permit):

```python
# packages/pycommon/pycommon/observability.py
"""CloudWatch Embedded Metric Format.

The Lambda runtime scrapes EMF JSON from stdout and publishes it as a real
metric, so this costs zero network calls and cannot fail the request.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

_NAMESPACE = "Foodo/Dispatch"


def emit_metric(name: str, value: float, unit: str = "Count", **dimensions: str) -> None:
    payload = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": _NAMESPACE,
                    "Dimensions": [list(dimensions.keys())] if dimensions else [[]],
                    "Metrics": [{"Name": name, "Unit": unit}],
                }
            ],
        },
        name: value,
        **dimensions,
    }
    # Single line: the runtime parses one JSON object per line.
    print(json.dumps(payload), flush=True)
```

```python
# dispatch_service.py
from pycommon.observability import emit_metric

# in handle_event, after the decision is made:
emit_metric(
    "OrdersDispatched",
    1,
    RestaurantId=ready.restaurant_id,   # dimension cardinality discipline: keep it low
    Mode=decision.mode,
)
if decision.broadcast:
    emit_metric("OrdersBroadcast", 1)
emit_metric("DecisionLatencyMs", (time.perf_counter() - started) * 1000, unit="Milliseconds")
```

```python
# routes.py — /health is liveness, /snapshot is operational state drawn from DynamoDB
@router.get("/snapshot")
async def snapshot(request: Request, _: None = Depends(require_internal)) -> dict[str, Any]:
    service = get_service()
    return {
        # Live, durable state — the pool rows are in DynamoDB, so this is real.
        "pending_pool": service.snapshot()["pending_pool"],
        # Per-container diagnostics. Named so nobody mistakes it for a total.
        "container": {"dispatched_since_cold_start": service.health.orders_dispatched,
                      "age_seconds": time.time() - service._started_at},
        "note": "Aggregate counts live in CloudWatch: Foodo/Dispatch OrdersDispatched",
    }
```

**Trade-offs:**
- EMF metrics are only ingested for logs at `INFO` (or whatever level `print` maps to); a log-level filter that suppresses stdout kills the metrics. `configure_logging(settings.log_level)` must never filter `print`, and the Lambda must not have a `LoggingConfig` `LogFormat: JSON` override that rewraps the payload.
- EMF adds ~200 bytes per event to CloudWatch Logs ingestion, which is itself metered. At dispatch volumes (~thousands/day) it is free-tier noise; at millions it matters and you would switch to a batched counter emitted once per batch.
- Custom metrics cost **$0.30 per metric-month** each, so dimensioning on `RestaurantId` multiplies the bill by the restaurant count. Dimension on `Mode` only; put `restaurantId` in the log line instead.
- The `/health` endpoint stays as liveness (it must not touch DynamoDB, or an ECS/ALB probe becomes a database dependency). Keep the split honest and document that `/snapshot` is *not* a health check.

---

# Part D — FinOps

> The platform's FinOps basics are genuinely good: `BillingMode: PAY_PER_REQUEST` everywhere, `logRetentionInDays: 14` on every stack, `natGateways` defaulting to `0`, SNS push instead of idle queues, and no provisioned capacity. The waste below is therefore all *incremental* — it comes from per-request multipliers and from resources nothing reads.

## D-01 · `UploadsBucket` has no lifecycle policy — and nothing writes to it

**Severity & Impact:** **FinOps** — an unbounded bucket, plus an orphaned resource with `DeletionPolicy: Retain`.

**Location:** `infra/serverless.yml:250-271`

```yaml
UploadsBucket:
  Type: AWS::S3::Bucket
  DeletionPolicy: Retain
  Properties:
    BucketName: ${self:service}-${sls:stage}-uploads
    PublicAccessBlockConfiguration:
      BlockPublicAcls: true
      BlockPublicPolicy: true
      IgnorePublicAcls: true
      RestrictPublicBuckets: true
    BucketEncryption:
      ServerSideEncryptionConfiguration:
        - ServerSideEncryptionByDefault: { SSEAlgorithm: AES256 }
    LifecycleConfiguration:
      Rules:
        - Id: abort-incomplete-multipart-uploads
          Status: Enabled
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
```

**The Flaw:**
Two findings in one resource:

1. **No expiry, no transition.** The only lifecycle rule aborts incomplete multipart uploads. Any object that lands in this bucket is retained at Standard-class pricing **forever**, with no archival tier and no deletion. There is no `Expiration`, no `Transition`.

2. **Nothing writes to it.** Every image in the platform goes to Cloudinary — `apps/web/src/lib/cloudinary-upload.ts`, `ai-verification`'s `storeEvidence` (Cloudinary), and the dispute photo path. No IAM statement in any of the 13 stacks grants `s3:PutObject` on this bucket. `grep -rn "UploadsBucket" backend/` returns no consumer. The messaging library explicitly recommends the S3 claim-check pattern for large payloads (`messaging.ts:160-162`) but the bucket it would use has never been wired to a producer.

So: a bucket that cannot grow, with no lifecycle policy, plus a `DeletionPolicy: Retain` that guarantees it survives stack deletion as an orphan somebody will find in a billing report two years from now.

**The Fix:**

**Option A — keep it and make it the claim-check target (recommended, because C-10's payload fix needs one):**

```yaml
UploadsBucket:
  Type: AWS::S3::Bucket
  DeletionPolicy: Retain
  UpdateReplacePolicy: Retain
  Properties:
    BucketName: ${self:service}-${sls:stage}-uploads
    PublicAccessBlockConfiguration:
      BlockPublicAcls: true
      BlockPublicPolicy: true
      IgnorePublicAcls: true
      RestrictPublicBuckets: true
    BucketEncryption:
      ServerSideEncryptionConfiguration:
        # SSE-S3, not SSE-KMS: at claim-check volumes the $0.03/10k KMS
        # request charge exceeds the storage cost of the objects.
        - ServerSideEncryptionByDefault: { SSEAlgorithm: AES256 }
    LifecycleConfiguration:
      Rules:
        - Id: abort-incomplete-multipart-uploads
          Status: Enabled
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }

        # Claim-check payloads: consumed within minutes, reaped in a week.
        - Id: expire-claim-check-payloads
          Status: Enabled
          Prefix: "payloads/"
          ExpirationInDays: 7

        # Verification evidence: must survive the chargeback window.
        # 90 d Standard → 400 d Glacier IR → gone. Mirrors EVIDENCE_TTL_DAYS.
        - Id: tier-evidence
          Status: Enabled
          Prefix: "evidence/"
          Transitions:
            - { TransitionInDays: 30, StorageClass: STANDARD_IA }
            - { TransitionInDays: 90, StorageClass: GLACIER_IR }
          ExpirationInDays: 400

        # Catch-all: nothing lives in this bucket for a year unexamined.
        - Id: default-expiry
          Status: Enabled
          ExpirationInDays: 365
```

**Option B — delete it,** since nothing uses it. Removing the resource *and* its CloudFormation output is the honest fix; leaving `DeletionPolicy: Retain` means the CFN delete succeeds while the bucket (and its bill) persists.

**Trade-offs:**
- Glacier IR retrieves in milliseconds but bills a 90-day minimum storage duration; objects deleted earlier are charged as if they lived 90 days. For evidence at 90 d that is exactly the boundary — a 30-day IA → 90-day GIR → 400-day expiry policy is neutral to slightly beneficial. Do not shorten it below 90 d in GIR.
- `Retain` + `UpdateReplacePolicy: Retain` means a bucket-name change orphans the old bucket silently. If you keep it, add a one-line runbook note and a periodic `aws s3api list-buckets | grep foodo` orphan check.
- Option A creates an operational obligation: someone must actually write the claim-check producer/consumer (C-10) or the `payloads/` prefix stays empty and the policy is decoration.
- SSE-S3 rather than SSE-KMS is a deliberate compliance trade. If verification evidence later falls under a regime requiring customer-managed keys, this becomes an exception to be revisited — the cost delta at evidence volumes is real ($0.03/10k KMS requests vs ~$0.023/GB-month storage).

---

## D-02 · `AuthorizerResultTtlInSeconds: 0` doubles the Lambda invocations on every authenticated request

**Severity & Impact:** **FinOps** — 100% overhead on the authorizer Lambda, on the platform's hottest path.

**Location:** `core/serverless.yml:102-118`

```yaml
FoodoJwtAuthorizer:
  Type: AWS::ApiGatewayV2::Authorizer
  Properties:
    ApiId: !Ref HttpApi
    Name: foodo-jwt
    AuthorizerType: REQUEST
    AuthorizerPayloadFormatVersion: "2.0"
    EnableSimpleResponses: true
    # No result caching: the web app authenticates via cookie,
    # and caching on a full-Cookie identity source risks both
    # stale denials and missing-identity-source failures. The
    # authorizer is a 128MB pure-JWT verify — cheap enough to
    # run per request.
    AuthorizerResultTtlInSeconds: 0
```

**The Flaw:**
The comment is half-right and that is what makes it expensive. It correctly identifies the problem — *"caching on a full-Cookie identity source"* — but the root cause is **not** the TTL. It is that **no `IdentitySource` is declared at all.**

With no `IdentitySource`, API Gateway has no documented way to derive a cache key, so caching is unusable and must be disabled. Turning the TTL up alone will not work; the authorizer's result would be cached under an empty key and every user would receive the first user's claims. That is an authentication bypass, not an optimisation. So the current setting is *correct given the configuration*, and the configuration is what must change.

What it costs: every authenticated API request invokes **two** Lambdas. At the 2 s payment poll (C-12) that is 60 extra invocations per minute per checkout tab, plus the same for every adopter of every other polled screen. At 1M authenticated requests/month:

| | Invocations | GB-s (@128 MB, 20 ms) |
|---|---|---|
| Today | 2,000,000 | 5,120 |
| With 30 s TTL, 20 requests/session-minute | ~1,050,000 | 2,688 |

Roughly **$0.06/month per million requests** in Lambda alone — small in absolute terms, but it is a pure 2× on the platform's request-handling compute, and it also doubles the authorizer's contribution to cold starts.

**The Fix:**
Declare the identity source explicitly, on a header the client controls, and enable a short TTL. Keep the cookie path working by mirroring the session JWT into `Authorization` client-side.

```yaml
FoodoJwtAuthorizer:
  Type: AWS::ApiGatewayV2::Authorizer
  Properties:
    ApiId: !Ref HttpApi
    Name: foodo-jwt
    AuthorizerType: REQUEST
    AuthorizerPayloadFormatVersion: "2.0"
    EnableSimpleResponses: true
    # Explicit, narrow identity source. Cookies are NOT used here on
    # purpose: a Cache-Control-relevant identity source must be a small,
    # stable string. The client mirrors the session JWT into this header.
    IdentitySource: ["$request.header.Authorization"]
    # 30 s: long enough to collapse a screen's burst (poll + parallel
    # panel fetches), short enough that a logout propagates within half
    # a minute. Bounded by the 15-min access-token TTL, so a cached
    # ALLOW can never outlive the token that granted it.
    AuthorizerResultTtlInSeconds: 30
    AuthorizerUri: !Sub
      - arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations
      - FnArn: !GetAtt JwtAuthorizerLambdaFunction.Arn
```

```ts
// apps/web/src/lib/session.ts — ONE accessor, so the header and the cookie
// can never disagree.
export function readSessionJwt(): string | null {
  const raw = document.cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if (!raw) return null;
  const decoded = decodeURIComponent(raw);
  // The cookie is `base64(JSON).jwt` — the JWT is the segment after the last dot.
  const jwt = decoded.slice(decoded.lastIndexOf(".") + 1);
  return jwt || null;
}

// apps/web/src/lib/api-client.ts
api.interceptors.request.use((config) => {
  const jwt = readSessionJwt();
  if (jwt && !config.headers?.["Authorization"]) {
    config.headers = { ...config.headers, Authorization: `Bearer ${jwt}` };
  }
  return config;
});
```

And keep the cookie fallback inside the authorizer so nothing breaks during rollout — but make it a *second* source, not the only one:

```ts
// core/src/authorizer.ts
const extractToken = (event: APIGatewayProxyEventV2) =>
  event.headers?.authorization?.replace(/^Bearer\s+/i, "") ??
  cookieJwt(event.cookies ?? []);   // unchanged, kept for compatibility
```

**Trade-offs:**
- **A cached `ALLOW` outlives a logout by up to 30 s.** That is the deliberate price. Do not raise the TTL past the access-token TTL (15 min) under any circumstances; at that point a revoked token works for its full life, which is exactly what `refresh` rotation was built to prevent.
- **A cached `DENY` delays a fresh login by up to 30 s** if the deny was keyed on a token the user then replaced. Because the identity source is the token (not the IP or a user id), a new login produces a new token and therefore a new cache key — so this does not happen. It *would* happen if you keyed on `$request.header.Cookie`, which is why the cookie must not be the identity source.
- Moving the JWT into `Authorization` puts it somewhere `document.cookie` hygiene cannot reach — but the token is already readable by any script on the page (the session cookie is `httpOnly: false` because the client must parse it). If you want XSS resistance, the correct end state is `httpOnly` + cookie-only auth with `IdentitySource: ["$request.header.Cookie"]` and a TTL of `0` — which is today's configuration. **That is a legitimate choice;** if you make it, say so in the comment so the next reader does not "optimise" it into a security hole.
- `memorySize: 128` → `256` on `jwtAuthorizer` costs ~$0.0000004/request more and roughly halves cold-start duration for a JWT verify in a Node 24 runtime. At these invocation counts the memory increase is cheaper than the latency.
- API Gateway HTTP API authorizer caching has a documented quirk: the TTL applies per (authorizer, identity source value), and a value over 2048 characters is hashed. A JWT is ~400 bytes, so it is fine — but do not add claims that push it past 2 KB.

---

## D-03 · Point-in-time recovery is missing on two tables that hold money

**Severity & Impact:** **FinOps + High correctness** — PITR costs $0.20/GB-month; its absence on `VouchersTable` and `ReviewQueueTable` means an accidental delete is unrecoverable.

**Location:** `infra/serverless.yml`

| Table | Line | PITR | Correct? |
|---|---|---|---|
| `UsersTable` | 322 | yes | yes |
| `RestaurantsTable` | 349 | yes | yes |
| `RidersTable` | 374 | yes | yes |
| `OrdersTable` | 399 | yes | yes |
| `MenuItemsTable` | 447 | **no** | **no** — whole catalogue |
| `CartsTable` | 465 | **no** | yes — recoverable by the user |
| `AddressesTable` | 477 | **no** | yes — recoverable |
| `WebhookDedupeTable` | 489 | **no** | yes — 24 h TTL, worthless after |
| `ArbitrationCasesTable` | 522 | yes | yes |
| `RefundLedgerTable` | 558 | yes | yes (still unused — see A-02) |
| `VouchersTable` | 580 | **no** | **no** — monetary instruments |
| `ReviewQueueTable` | 609 | **no** | **no** — human escalation queue |
| `VerificationsTable` | 638 | yes | yes |
| `RateLimitsTable` | 682 | **no** | yes — ephemeral by design |
| `DispatchStateTable` | 704 | **no** | yes — claims with TTL |
| `Connections` (realtime) | 93 | **no** | yes — ephemeral |

**The Flaw:**
The PITR exclusions are mostly *right* — excluding `Carts`, `Addresses`, `WebhookDedupe`, `RateLimits`, `DispatchState` and `Connections` is correct discipline, because those tables are either user-recreatable or TTL-ephemeral, and PITR on them is pure cost.

Three exclusions are wrong:

1. **`VouchersTable`** holds agent-issued discount instruments. `ai-orchestrator` caps issuance with `VOUCHER_CAP = 150` and codes are deterministic (`FOODO-AGENT-<caseId last 8>`), so a lost table means a customer holds a code the system no longer honours — a support incident with a monetary resolution. Losing a voucher row is indistinguishable from a fraud event.
2. **`ReviewQueueTable`** is the human review escalation queue for verifications and disputes. It is not derived from anything else; it *is* the queue. A bad deploy that deletes rows silently drops escalations.
3. **`MenuItemsTable`** is the entire catalogue. The recommendation is softer here (it is re-creatable from a restaurant's own data, at the cost of a supplier conversation), but the table is small, cheap to protect, and its loss is a platform-wide outage.

Cost reality check, so this is decided honestly: PITR is **$0.20 per GB-month** of *table size*. `VouchersTable` and `ReviewQueueTable` together will not exceed a few hundred MB — call it **$0.10/month**. `MenuItemsTable` at 5 GB is $1.00/month. This is not a FinOps decision at all; it is a decision to *not* have a recovery mechanism for money.

**The Fix:**

```yaml
VouchersTable:
  Type: AWS::DynamoDB::Table
  DeletionPolicy: Retain
  Properties:
    # ... unchanged ...
    PointInTimeRecoverySpecification:
      PointInTimeRecoveryEnabled: true

ReviewQueueTable:
  Type: AWS::DynamoDB::Table
  DeletionPolicy: Retain
  Properties:
    PointInTimeRecoverySpecification:
      PointInTimeRecoveryEnabled: true

MenuItemsTable:
  Type: AWS::DynamoDB::Table
  DeletionPolicy: Retain
  Properties:
    PointInTimeRecoverySpecification:
      PointInTimeRecoveryEnabled: true
```

And make it un-regressable, because a YAML table is exactly the kind of thing a copy-paste drops:

```js
// scripts/assert-pitr.js — run in CI after deploy
const { DynamoDBClient, DescribeContinuousBackupsCommand } = require("@aws-sdk/client-dynamodb");

const REQUIRED = ["users", "restaurants", "riders", "orders", "menu-items",
                  "arbitration-cases", "refund-ledger", "vouchers",
                  "review-queue", "verifications"];

(async () => {
  const client = new DynamoDBClient({});
  const missing = [];
  for (const name of REQUIRED) {
    const table = `foodo-infra-${process.env.STAGE}-${name}`;
    const out = await client.send(new DescribeContinuousBackupsCommand({ TableName: table }));
    const status = out.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
    if (status !== "ENABLED") missing.push(`${table}=${status}`);
  }
  if (missing.length) {
    console.error("PITR missing:", missing.join(", "));
    process.exit(1);
  }
})();
```

**Trade-offs:**
- `PointInTimeRecoverySpecification` is an in-place CFN update on DynamoDB — no replacement, no downtime. This is genuinely a one-line change per table.
- PITR is per-*table* size, so a table with a TTL sweeper that has not yet deleted expired items is billed on the un-swept size. `ReviewQueueTable`'s rows are small; not a concern.
- The CI assertion adds a hard dependency on deployed resource names matching `foodo-infra-${stage}-*`. If any table is renamed, the assertion fails closed — which is the intent, but it will page someone. Treat the list as the canonical inventory and update it in the same commit as any table change.
- Do **not** add PITR to `CartsTable` "for symmetry". It is genuinely disposable and adding it invites the argument that the other exclusions were wrong too.

---

## D-04 · Six DLQs, zero alarms, zero budgets, zero dashboards

**Severity & Impact:** **FinOps + High** — the platform has no mechanism to notice that money is being lost or that spend has tripled.

**Location:** repository-wide. `grep -rn "AWS::CloudWatch::Alarm\|AWS::Budgets::Budget\|AWS::CloudWatch::Dashboard" --include=serverless.yml` returns nothing.

Existing DLQs, all with `redrivePolicy` and 14-day retention, none with an alarm:

| DLQ | Defined in | Meaning of a message in it |
|---|---|---|
| `PaymentQueueDLQ` | `infra/serverless.yml` | A payment event failed 5× — the order is paid but the state machine never advanced |
| `OrderQueueDLQ` | `infra/serverless.yml` | The rider matcher never ran for a ready order |
| `AgentDisputesQueueDLQ` | `infra/serverless.yml:808-823` | An AI dispute run failed permanently |
| `RiderEventsQueueDLQ` | `restaurant-service/serverless.yml` | A rider event was permanently lost |
| `RealtimeEventsDLQ` | `realtime-service/serverless.yml` | A customer never saw a status change |
| `DispatchOrdersQueueDLQ` | `ai-dispatch` (if enabled) | The swarm dropped an order |

**The Flaw:**
A DLQ with no alarm is a **write-only log**. Every one of these queues is correctly configured — retry limits, retention, redrive policy — and the messages that land in them are the highest-signal events the platform produces. Nobody is told. The failure mode is: a payment consumer starts failing at 02:00, 47 orders sit in `PaymentQueueDLQ` as `paid` but never advance, and it is discovered when customers complain the next morning.

There is also no budget guard: no `AWS::Budgets::Budget`, so a runaway loop (C-11's retries, B-02's unbounded `Promise.all`, a scanner stuck in a retry) is discovered on the invoice.

**The Fix:**

```yaml
# infra/serverless.yml — resources.Resources
  OpsAlertTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: ${self:service}-${sls:stage}-ops-alerts
      KmsMasterKeyId: alias/aws/sns
      Subscription:
        - Protocol: email
          Endpoint: ${env:OPS_ALERT_EMAIL, 'ops@foodo.example'}

  # ── Any message in a DLQ is an incident, not a metric. Threshold 1.
  PaymentQueueDLQAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: ${self:service}-${sls:stage}-payment-dlq-not-empty
      AlarmDescription: A payment event failed 5 deliveries. An order is paid but stuck.
      Namespace: AWS/SQS
      MetricName: ApproximateNumberOfMessagesVisible
      Dimensions:
        - { Name: QueueName, Value: !GetAtt PaymentQueueDLQ.QueueName }
      Statistic: Maximum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref OpsAlertTopic]

  OrderQueueDLQAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: ${self:service}-${sls:stage}-order-dlq-not-empty
      Namespace: AWS/SQS
      MetricName: ApproximateNumberOfMessagesVisible
      Dimensions:
        - { Name: QueueName, Value: !GetAtt OrderQueueDLQ.QueueName }
      Statistic: Maximum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref OpsAlertTopic]

  # ── Backpressure: depth rising means consumers are slower than producers.
  PaymentQueueDepthAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: ${self:service}-${sls:stage}-payment-queue-depth
      Namespace: AWS/SQS
      MetricName: ApproximateNumberOfMessagesVisible
      Dimensions:
        - { Name: QueueName, Value: !GetAtt PaymentQueue.QueueName }
      Statistic: Maximum
      Period: 300
      EvaluationPeriods: 2
      Threshold: 200
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref OpsAlertTopic]

  PaymentConsumerErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: ${self:service}-${sls:stage}-payment-consumer-errors
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions:
        - { Name: FunctionName, Value: ${self:service}-${sls:stage}-paymentConsumer }
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 5
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref OpsAlertTopic]

  # ── The FinOps guardrail. Thresholds are % of MONTHLY budget.
  MonthlyBudget:
    Type: AWS::Budgets::Budget
    Properties:
      Budget:
        BudgetName: ${self:service}-${sls:stage}-monthly
        BudgetType: COST
        TimeUnit: MONTHLY
        BudgetLimit: { Amount: 300, Unit: USD }
      NotificationsWithSubscribers:
        - Notification:
            NotificationType: ACTUAL
            ComparisonOperator: GREATER_THAN
            Threshold: 80
          Subscribers:
            - { SubscriptionType: EMAIL, Address: ${env:OPS_ALERT_EMAIL, 'ops@foodo.example'} }
        - Notification:
            NotificationType: FORECASTED
            ComparisonOperator: GREATER_THAN
            Threshold: 100
          Subscribers:
            - { SubscriptionType: EMAIL, Address: ${env:OPS_ALERT_EMAIL, 'ops@foodo.example'} }
```

Repeat the DLQ pattern for the other four queues, substituting the queue logical IDs (`AgentDisputesQueueDLQ`, `RiderEventsQueueDLQ`, `RealtimeEventsDLQ`).

**Trade-offs:**
- **Six alarms × $0.10/metric-month, plus budget $0, plus SNS email $0** ≈ **$0.60/month**. This is the highest return-on-spend change in the document.
- Alarm fatigue is the real risk. `Threshold: 1` on a DLQ is correct because *any* message is a genuine failure — but only if the DLQ is genuinely empty in normal operation. Before shipping, delete the alarms' `TreatMissingData` assumptions and watch the queues for a week. If one DLQ routinely receives a benign message class, fix the consumer, do not raise the threshold.
- `deploy:core`/`deploy:infra` ordering matters: an alarm referencing `${self:service}-${sls:stage}-paymentConsumer` assumes the function name matches the Serverless default. `restaurant-service` runs `paymentConsumer`, not `infra`, so that alarm belongs in `restaurant-service/serverless.yml`, not `infra`. Split the YAML above by owning stack.
- Email subscribers are a placeholder path. Replace with the ops alias; an alarm that emails a dead inbox is the same as no alarm. PagerDuty/Slack via SNS-to-Lambda is the next step, not this one.
- `AWS::Budgets::Budget` requires the account-level `budgets:ModifyBudget` permission, which some org SCPs block. If it fails to deploy, move the budget out of the stack and create it once in the console — do not let it block the DLQ alarms.

---

## D-05 · A Cognito user pool and a VPC with 2 NAT Gateways in prod that nothing uses

**Severity & Impact:** **FinOps** — up to ~$66/month of NAT plus an idle user pool, for resources with zero consumers.

**Location:** `infra/serverless.yml:273-300` (Cognito), `:1-100` (network), `:17-40` (`natGateways` parameter)

```yaml
UserPool:
  Type: AWS::Cognito::UserPool
  Properties:
    # provisioned now for the identity migration
```

```yaml
Parameters:
  natGateways:
    Type: Number
    Default: 0
    AllowedValues: [0, 1, 2]
    Description: NAT gateways to create (0 in dev, 2 in prod)
```

**The Flaw:**
Three resources exist with no consumer:

1. **Cognito `UserPool` + `UserPoolClient`** — the comment says *"provisioned now for the identity migration"*. No Lambda, no frontend code, and no IAM policy references either. Auth is entirely custom (`auth-service` + HS256 JWT + `core/authorizer.ts`). A Cognito user pool with no users costs approximately nothing — but it costs an *architectural* decision: it is a second, unimplemented identity system that future readers must reconcile with the live one.
2. **VPC / subnets / IGW / NAT** — `grep -rn "^\s*vpc:" backend/*/serverless.yml` returns nothing. **No Lambda is attached to the VPC.** The network tier is entirely decorative.
3. **`natGateways` defaults to `0` in dev — correct — and the parameter's own description says "2 in prod".** Two NAT gateways cost **$0.045/hour each = $32.85/month each, $65.70/month total**, plus **$0.045/GB** processed. That is the single largest fixed cost in this file, and **nothing routes through it.**

If prod was ever deployed with `--param natGateways=2`, the platform has been paying ~$66/month for two NAT gateways serving zero packets since inception.

**The Fix:**
Make them conditional, so the decision is explicit and the cost is zero until something needs it:

```yaml
Parameters:
  provisionNetwork:
    Type: String
    Default: "false"
    AllowedValues: ["true", "false"]
    Description: Create the VPC/subnets/NAT tier. Only enable when a Lambda needs private egress.
  provisionCognito:
    Type: String
    Default: "false"
    AllowedValues: ["true", "false"]
    Description: Create the (currently unused) Cognito pool for the identity migration.

Conditions:
  ProvisionNetwork: !Equals [!Ref provisionNetwork, "true"]
  ProvisionCognito: !Equals [!Ref provisionCognito, "true"]
  ProvisionNat: !And
    - !Condition ProvisionNetwork
    - !Not [!Equals [!Ref natGateways, "0"]]

Resources:
  FoodoVpc:
    Type: AWS::EC2::VPC
    Condition: ProvisionNetwork
    # ...

  # ONE NAT, not two. A second NAT buys AZ-independent egress; a Lambda
  # in two private subnets with one NAT loses egress for half the fleet
  # if that AZ fails. Accept that, or pay $32.85/mo for the redundancy.
  NatGateway:
    Type: AWS::EC2::NatGateway
    Condition: ProvisionNat
    # ...

  UserPool:
    Type: AWS::Cognito::UserPool
    Condition: ProvisionCognito
    # ...
```

**Trade-offs:**
- **One NAT instead of two halves AZ redundancy.** With a single NAT, an AZ outage removes egress for every Lambda in that VPC — and since the NAT lives in one AZ, it removes egress for *all* of them. This is a legitimate reason to keep two NATs **if** you actually need private egress. You currently do not need it at all, which makes the redundancy question moot until the VPC is used.
- CloudFormation `Conditions` on resources referenced by outputs require the outputs to be conditional too, or the stack fails with "unresolved resource dependencies". Gate every `Outputs` entry that references a conditional resource.
- Deleting the Cognito pool deletes the users in it. It has none, so this is safe **now** — verify with `aws cognito-idp list-users --user-pool-id <id>` before deploying, or you will destroy an identity migration in progress.
- If the identity migration is genuinely planned, keeping the pool costs ~$0 and preserves the schema work. The honest middle ground is `provisionCognito: "true"` in prod only, with the conditional wired so dev never creates it.
- **Better than the VPC question:** if a future need is "call a third party that requires IP allowlisting", the cheaper answer is usually an egress-only path via a Lambda in a public subnet with a stable EIP, not a full VPC + NAT. Price that before re-enabling the network tier.

---

## D-06 · The three remaining SQS pollers are the *correct* choice — do not "optimise" them

**Severity & Impact:** **Positive finding** — documented explicitly so a future reader (or audit) does not refactor a correct design into a worse one.

**Location:**
- `restaurant-service/serverless.yml` — `paymentConsumer` ← `PaymentQueue` (`batchSize: 5`, `maximumBatchingWindow: 5`, `ReportBatchItemFailures`)
- `rider-service/serverless.yml` — `orderReadyConsumer` ← `OrderQueue` (same shape)
- `ai-orchestrator` — `disputeConsumer` ← `AgentDisputesQueue` (`batchSize: 1`, `VisibilityTimeout: 720`)

**The Flaw (in the *hypothetical* optimisation):**
A generic audit would flag "SQS event source mappings" as idle polling and recommend converting them to direct SNS subscriptions. Applied here, that would be wrong for three specific reasons, all visible in the repo's own configuration:

1. **These are work queues, not fanout.** The distinction the codebase already makes correctly (`messaging.ts:60-120` vs `:157-203`) is: *fanout* = one fact, many independent consumers → SNS; *work* = one job, one worker, with retry and ordering semantics → SQS. A payment event must be processed exactly once by exactly one consumer. SNS would deliver it to every subscriber and then forget it.
2. **The retry contract only exists on the SQS side.** `VisibilityTimeout`, `maxReceiveCount: 5`, DLQ redrive, and `ReportBatchItemFailures` are the entire poison-pill defence (B-02, B-08). SNS subscriptions have an independent, differently-shaped retry policy and no per-item failure reporting.
3. **The idle cost is genuinely near-zero.** The `ai-dispatch` stack documents this reasoning itself:

   > *"Push, not poll: SNS invokes the function per matching event. A queue here would cost ~130k SQS requests/month while idle, and the `READY#<orderId>/SEEN` conditional claim already makes the handler idempotent under SNS's at-least-once delivery."*

   That comment is correct — **for dispatch**, where the event genuinely is a fanout signal that the swarm may or may not act on. For the three work queues above, an empty queue costs $0 (no requests when no messages); a queue holding ~1,000 messages/month costs ~$0.05.

**The Fix:**
None. Keep the pollers. Spend the effort on the things that actually leak:

| Real leak | Where | Documented |
|---|---|---|
| Authorizer invoked per request | `core/serverless.yml:115` | D-02 |
| 5 × `ALL`-projection GSIs | `infra/serverless.yml:419-446` | C-06 |
| `ALL`-projection low-cardinality indices | `infra/serverless.yml:369-372, 394-397` | C-08 |
| Client polling overriding cache | `apps/web/src/features/*/api` | C-12 |
| Unused NAT tier in prod | `infra/serverless.yml` `natGateways` | D-05 |
| Unused bucket with no lifecycle | `infra/serverless.yml:250-271` | D-01 |

**Trade-offs:**
- Documenting a non-issue has a cost: this section occupies space that could describe a real defect. It is included because the failure mode it prevents — someone "modernising" the payment consumer to SNS and silently losing `ReportBatchItemFailures` and the DLQ — is severe and plausible.
- The one legitimate SQS→SNS candidate, if you ever find one, is a queue where the average queue depth is 0 but a schedule still polls it. None of the three match that; all three are producer-driven.
- If `AgentDisputesQueue`'s usage ever drops to near-zero *and* its `VisibilityTimeout: 720` is never approached, revisit — but the right change then is `batchSize`/`maximumBatchingWindow` tuning, not a transport swap.

---

# Part E — Architectural boundaries and coupling

> Parts A–D are defects. This part is about the *shape* of the system: which couplings are load-bearing, which are accidental, and what will break first as the platform grows. Nothing here is fixable in a single patch; all of it is cheaper to fix now than later.

## E-01 · `OrdersTable` is the integration contract between six services, and it has no ACL

**Severity & Impact:** **High** — schema changes are platform-wide breaking changes, and there is no boundary at which a service's ownership of the order record can be asserted.

**Location:**
- `infra/serverless.yml:399-446` — `OrdersTable`, one table, five GSIs
- Consumers of that table across stacks:
  - `restaurant-service` — writes (create, status, refund append, payment claim)
  - `rider-service` — reads via `rider-orders` GSI, writes `riderId`/status (`assignRider`, `transitionRiderStatus`)
  - `utils-service` — reads for refund cap, writes `refunds`
  - `admin-service` — reads via `user-orders`/`restaurant-orders`/`status-board`
  - `ai-dispatch` — reads via `ORDERS_TABLE` env var (Python, `boto3`)
  - `ai-orchestrator` — reads orders for dispute context
- `RidersTable` is shared the same way: `rider-service` owns it, `ai-dispatch` reads the roster directly (`RIDERS_TABLE`)

```yaml
# ai-dispatch/serverless.yml:123-126
DISPATCH_STATE_TABLE: ${cf:${self:custom.infra}.DispatchStateTable}
ORDERS_TABLE: ${cf:${self:custom.infra}.OrdersTable}      # ← direct table access, cross-language
RIDERS_TABLE: ${cf:${self:custom.infra}.RidersTable}
EVENTS_TOPIC_ARN: ${cf:${self:custom.infra}.EventsTopicArn}
```

**The Flaw:**
The order lifecycle has exactly one owner in name (`restaurant-service`) and six writers in fact. There is no anti-corruption layer: `ai-dispatch` reads the table with `boto3` and reconstructs order semantics from raw attribute names, so the Python tier is coupled to `packages/backend-common`'s `toOrder()` mapping — without importing it, without a type check, and without a test that would fail when the mapping changes.

The concrete consequences:

1. **Renaming a field is a coordinated six-stack deploy.** `paymentStatus` → `payment.state` is a one-line change in `backend-common`, a matching change in Python, and a lock-step deploy across two languages and six stacks. Because CloudFormation deploys are not atomic across stacks, there is necessarily a window where one service reads a field another no longer writes.
2. **`ProjectionType: ALL` exists partly to serve this coupling** (C-06). Five GSIs copy the whole item because six different services read five different subsets, and nobody wanted to negotiate the projection. That is the *correct* instinct — `ALL` is a legitimate choice when you cannot enumerate consumers — but it is a symptom, not a solution.
3. **`assignRider` / `transitionRiderStatus` live in `backend-common`** (`Order.ts:529-639`) and are called by `rider-service`. So the rider saga's state transitions are implemented in a library the rider service does not own, that the restaurant service also imports. There is no way to change the rider assignment logic without reviewing changes that reach every importer of `backend-common`.
4. **The `Docs/04-data-model.md` is the only place the schema is described**, and nothing enforces it. A new GSIs, a new attribute, a new enum value — all invisible to the doc until someone remembers.

**The Fix:**
You will not extract a service boundary in a week. The affordable, high-value move is to make the coupling **explicit and checked**, so drift fails loudly instead of silently:

```ts
// packages/backend-common/src/dynamo/order-schema.ts
/**
 * The order record as the platform agrees it. This file is the contract.
 * Anything not here does not exist. Changing it is a breaking change for
 * six stacks and must ship with a migration note in docs/04-data-model.md.
 */
export const ORDER_STATUSES = [
  "placed", "accepted", "preparing", "ready_for_rider",
  "assigned", "picked_up", "delivered", "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Field-level ownership. Reviewed in PRs; asserted by the contract test. */
export const ORDER_WRITE_OWNERS = {
  restaurantId: "restaurant-service",
  status: "restaurant-service|rider-service",
  riderId: "rider-service",
  paymentStatus: "restaurant-service",
  refunds: "utils-service",
  refundedAmount: "utils-service",
} as const satisfies Partial<Record<keyof DynamoOrder, string>>;

export function assertValidStatusTransition(from: OrderStatus, to: OrderStatus): void {
  const allowed: Record<OrderStatus, OrderStatus[]> = {
    placed: ["accepted", "cancelled"],
    accepted: ["preparing", "cancelled"],
    preparing: ["ready_for_rider", "cancelled"],
    ready_for_rider: ["assigned", "cancelled"],
    assigned: ["picked_up", "cancelled"],
    picked_up: ["delivered"],
    delivered: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) {
    throw Object.assign(new Error(`Illegal transition ${from} → ${to}`), { status: 409 });
  }
}
```

Then generate the Python view from it rather than hand-maintaining it:

```python
# packages/pycommon/pycommon/order_contract.py — GENERATED, do not edit
# source: packages/backend-common/src/dynamo/order-schema.ts
ORDER_STATUSES = ("placed", "accepted", "preparing", "ready_for_rider",
                  "assigned", "picked_up", "delivered", "cancelled")
PAYMENT_STATUSES = ("pending", "paid", "failed", "refunded")
```

and add a CI step that regenerates and diffs it. A drift between the TS and Python views then fails the build instead of producing a silent `KeyError` in dispatch.

For the longer term, the correct target is: **`OrdersTable` is owned by `restaurant-service`; every other service calls it over HTTP or consumes its events.** The `refundedAmount`/`refunds` write (A-01/A-02) is the place to start, because `utils-service` writing `refunds` directly is the clearest boundary violation on the money path.

**Trade-offs:**
- A shared schema file does not create a boundary; it creates *visibility*. Expect some reviewers to mistake it for enforcement. It is enforcement only where something calls the assertion.
- Generating the Python contract adds a build step to `pycommon` and a diff-check to CI. Two small frictions for one eliminated class of bug.
- `assertValidStatusTransition` in `setOrderStatus` (the B-03 fix) will start rejecting transitions that currently succeed. Run it in log-only mode for a week first: `console.warn` instead of throw, and read the warnings. Some of them will be legitimate admin actions, and the allowed-transition table must be extended — not the assertion removed.
- The end-state (all cross-service reads over HTTP) trades a table read for an API call: more latency, more Lambda invocations, and a new failure mode (the owner service is down). That is the correct trade for a boundary, but it is a real trade. Consider it for money fields first and leave read-only analytics on direct table access.

---

## E-02 · `backend-common` is a distributed monolith, and its `isAuth` already diverges per service

**Severity & Impact:** **High** — a single library whose behaviour differs between callers, so "the auth middleware" means three different things depending on where you are.

**Location:**
- `packages/backend-common/src/middlewares/isAuth.ts:1-149` (both the `isAuth` used by seven services and the fail-open `isSeller`/`isAdmin`)
- `backend/auth-service/src/middlewares/isAuth.ts:1-47` (a *separate, stricter* implementation)
- `core/src/authorizer.ts:60-86` (a *third* implementation at the gateway)
- `packages/backend-common/src/middlewares/trycatch.ts` (the 500-collapsing variant) vs `tryCatchStatus` (the status-preserving variant used only by `admin-service`)

```ts
// backend-common/src/middlewares/isAuth.ts — DECODES, does not verify
const decoded = jwt.decode(token) as { sub?: string; role?: string } | null;
// ...
req.user = { id: decoded.sub, role: decoded.role };
next();
```

```ts
// backend/auth-service/src/middlewares/isAuth.ts — VERIFIES, and checks typ
const decode = jwt.verify(token, process.env.JWT_SECRET!) as { typ?: string; sub?: string };
if (!decode || decode.typ !== "access" || !decode.sub) {
  return res.status(401).json({ message: "Unauthorized" });
}
```

```ts
// core/src/authorizer.ts — VERIFIES, does NOT check typ
const claims = jwt.verify(token, process.env.JWT_SECRET!) as { sub?: string; role?: string };
if (!claims?.sub) return { isAuthorized: false };
```

**The Flaw:**
Three implementations of "is this request authenticated", with three different security properties, all describing themselves as the same thing:

| Location | Verifies signature | Checks `typ` | Fails |
|---|---|---|---|
| `core/authorizer.ts` | yes | **no** | closed (no `sub`) |
| `auth-service/middlewares/isAuth.ts` | yes | **yes** | closed |
| `backend-common/middlewares/isAuth.ts` | **no** (`jwt.decode`) | no | closed (no token → 401) |

The `backend-common` version is not *insecure* — every protected route in seven services sits behind the gateway authorizer, which does verify, so `jwt.decode` operates on an already-verified token. But that is a property of the *deployment*, not of the code. The library's correctness depends on an invariant enforced in a different stack (`core`). If a route is ever added without the authorizer — and `utils-service` and `ai-dispatch` already run entire `{proxy+}` route trees with no authorizer — `jwt.decode` accepts a forged token and the service is open.

That is exactly what has happened at the edges: `/api/utils/*` and `/api/dispatch/*` have no gateway authorizer, so their in-app checks are the only control, and for `utils-service` that is `isInternal` or nothing.

The second divergence is `tryCatch` (500 + `error.message`) vs `tryCatchStatus` (correct). One service uses the correct one. That is a library where the *worse* option is the default export path.

**The Fix:**
Collapse to one implementation, in one place, with one behaviour:

```ts
// packages/backend-common/src/middlewares/isAuth.ts — the ONLY auth middleware
import jwt from "jsonwebtoken";

export interface AuthUser { id: string; role?: string; typ: "access" | "socket" }

const gatewayClaims = (req: any) => {
  const event = req.apiGateway?.event ?? req.apiGateway;
  const claims = event?.requestContext?.authorizer?.lambda;
  return claims?.sub ? claims : undefined;
};

function verify(token: string): AuthUser {
  // verify(), never decode(). This library must be safe standing alone.
  const claims = jwt.verify(token, process.env.JWT_SECRET!, {
    algorithms: ["HS256"],
    maxAge: "15m",              // reject an expired token even if exp is absent
  }) as { sub?: string; role?: string; typ?: string };

  if (!claims?.sub) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  // Socket tokens are deliberately a NARROWER credential — see A-07.
  if (claims.typ !== "access") throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return { id: claims.sub, role: claims.role, typ: "access" };
}

export const isAuth = (req: any, res: any, next: any) => {
  try {
    const gw = gatewayClaims(req);
    if (gw) {
      // Gateway already verified. Trust it ONLY because the gateway is
      // configured with an explicit IdentitySource — see core/serverless.yml.
      req.user = { id: String(gw.sub), role: gw.role ? String(gw.role) : undefined, typ: "access" };
      return next();
    }
    const header = req.headers?.authorization as string | undefined;
    const token = header?.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Unauthorized" });
    req.user = verify(token);
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
```

```ts
// packages/backend-common/src/middlewares/trycatch.ts — one version, correct
export const tryCatch = <T extends (req: any, res: any, next: any) => unknown>(handler: T) =>
  async (req: any, res: any, next: any) => {
    try {
      await handler(req, res, next);
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status ?? 500;
      // Never leak internal messages on 5xx; do surface deliberate 4xx messages.
      const message = status >= 500 ? "Internal server error" : (error as Error)?.message ?? "Request failed";
      // 5xx means "we do not know what happened" — log the truth, return a lie.
      if (status >= 500) console.error("[unhandled]", error);
      return res.status(status).json({ message });
    }
  };
```

Then delete `auth-service`'s copy and `tryCatchStatus`, and add a lint rule or a `grep` check in CI:

```bash
# scripts/assert-no-auth-duplication.sh
if grep -rn "export const isAuth" --include=*.ts backend/ packages/ | grep -v "backend-common/src/middlewares/isAuth.ts"; then
  echo "ERROR: duplicate isAuth implementation found"
  exit 1
fi
```

**Trade-offs:**
- **This is a breaking change for `auth-service`**, whose routes are mounted before the gateway authorizer (they must be: `/api/auth/login` is public). It needs the local verify path, which the unified middleware provides via the `Bearer` branch — but `auth-service` also reads the `session` cookie. Either the cookie path moves into the unified middleware or `auth-service` keeps a thin, clearly-marked adapter. Prefer moving it in.
- `maxAge: "15m"` is a hard-coded duplicate of `ACCESS_TTL_SEC` in `auth-service/src/lib/tokens.ts`. Put the constant in `backend-common` and import it in both, or the two will drift and one of them will reject valid tokens.
- Removing `tryCatchStatus` requires auditing `admin-service`'s error paths. Its `status` propagation is probably load-bearing for a UI that shows specific messages. Verify before deleting, and if it is, fold the behaviour into the unified `tryCatch` rather than maintaining two.
- A single library that all services pin means **one version bump can break eight deploys at once**. That is the cost of consolidation and it is real. Mitigate with a canary: deploy one service (a low-traffic one, not `restaurant-service`) to staging with the bumped library before promoting to all.

---

## E-03 · No transactional outbox anywhere, at the three places that need one

**Severity & Impact:** **High** — the dual-write problem, three times, on the money and dispatch paths.

**Location:**
1. `backend/utils-service/src/controllers/refund.ts:281-310` — provider refund + ledger write (A-02)
2. `backend/restaurant-service/src/controllers/order.ts:440-460` — order status + two publishes (A-04)
3. `backend/rider-service/src/controllers/consumers.ts` — rider claim + event publish (mitigated by compensation — but only in that one place)

**The Flaw:**
The pattern is identical at each site: mutate a durable store, then publish an event, in two separate calls. There is no shared transaction, no outbox, and no reconciliation. Two of the three have no compensation at all; the third has one, and it is defeated by a missing client timeout (C-11).

The repo does not need a general outbox framework. It needs **one** pattern, applied three times, small enough that a reviewer can hold it. DynamoDB makes this cheap because the outbox row and the state change can be written in a single `TransactWriteItems`.

**The Fix:**
An outbox table plus a relay. The relay is the only component allowed to publish, which means publishing becomes a consequence of a committed transaction rather than a racing side effect.

```yaml
# infra/serverless.yml
  OutboxTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    Properties:
      TableName: ${self:service}-${sls:stage}-outbox
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: pk, AttributeType: S }       # OUTBOX#<shard>
        - { AttributeName: sk, AttributeType: S }       # <createdAt>#<eventId>
      KeySchema:
        - { AttributeName: pk, KeyType: HASH }
        - { AttributeName: sk, KeyType: RANGE }
      TimeToLiveSpecification:
        AttributeName: expiresAt
        Enabled: true
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
```

```ts
// packages/backend-common/src/dynamo/outbox.ts
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

export interface OutboxEvent {
  eventId: string;             // uuid; the dedupe handle downstream
  event: string;               // "order:ready_for_rider"
  payload: unknown;
  /** 8 shards keeps a single partition from becoming a hot key at relay time. */
  shard?: number;
}

export function outboxPut(evt: OutboxEvent): TransactWriteCommandInput["TransactItems"][number] {
  const createdAt = new Date().toISOString();
  return {
    Put: {
      TableName: process.env.OUTBOX_TABLE!,
      Item: {
        pk: `OUTBOX#${evt.shard ?? 0}`,
        sk: `${createdAt}#${evt.eventId}`,
        eventId: evt.eventId,
        event: evt.event,
        payload: evt.payload,
        createdAt,
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,   // still needs the publish to have happened
      },
      // Same eventId twice is a replay, not an error — but it must not duplicate.
      ConditionExpression: "attribute_not_exists(sk)",
    },
  };
}

/**
 * The state change and the event, atomically. Either both are true or neither is.
 */
export async function transactWithOutbox(
  items: TransactWriteCommandInput["TransactItems"],
  evt: OutboxEvent,
): Promise<void> {
  await docClient().send(new TransactWriteCommand({ TransactItems: [...items, outboxPut(evt)] }));
}
```

```ts
// backend/restaurant-service/src/controllers/order.ts — the A-04 site, fixed
await transactWithOutbox(
  [
    {
      Update: {
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression: "SET #s = :ready, updatedAt = :now",
        ConditionExpression: "#s = :preparing",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":ready": "ready_for_rider", ":now": new Date().toISOString() },
      },
    },
  ],
  { eventId: crypto.randomUUID(), event: "order:ready_for_rider", payload: readyPayload },
);
// No publish call here. The relay publishes. If it fails, it retries.
```

```ts
// backend/restaurant-service/src/handlers/outboxRelay.ts — scheduled every 10 s
import { QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PublishBatchCommand } from "@aws-sdk/client-sns";

export const handler = async (): Promise<void> => {
  // 8 shards queried in parallel; a shard is cheap because the row count is tiny.
  const shards = await Promise.all(
    Array.from({ length: 8 }, (_, shard) =>
      docClient().send(new QueryCommand({
        TableName: process.env.OUTBOX_TABLE!,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `OUTBOX#${shard}` },
        Limit: 100,
      })),
    ),
  );

  const rows = shards.flatMap((r) => r.Items ?? []);
  if (!rows.length) return;

  // PublishBatch: 10 per request. Every entry must carry its own eventId
  // as a MessageAttribute so subscribers can dedupe on redelivery.
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10);
    const out = await sns.send(new PublishBatchCommand({
      TopicArn: process.env.EVENTS_TOPIC_ARN,
      PublishBatchRequestEntries: chunk.map((row) => ({
        Id: row.eventId,
        Message: JSON.stringify({ eventId: row.eventId, event: row.event, data: row.payload }),
        MessageAttributes: { event: { DataType: "String", StringValue: row.event } },
      })),
    }));

    // Delete only what SNS accepted. Failed entries stay for the next run.
    const failed = new Set((out?.Failed ?? []).map((f) => f.Id));
    await Promise.all(
      chunk
        .filter((row) => !failed.has(row.eventId))
        .map((row) => docClient().send(new DeleteCommand({
          TableName: process.env.OUTBOX_TABLE!,
          Key: { pk: row.pk, sk: row.sk },
        }))),
    );
  }
};
```

**Trade-offs:**
- **At-least-once becomes structural.** The relay can publish and then crash before deleting, so every consumer *must* be idempotent on `eventId`. That is the same requirement the platform already meets for dispatch (`READY#<orderId>/SEEN` claim) and payments (`claimOrderForPayment`) — but it must now be true of all of them. Do not adopt an outbox without an idempotency story; you would be trading a rare lost event for a common duplicate stream.
- A 10-second relay introduces **up to 10 s of publish latency** on the order-ready path. That is unacceptable if the rider matcher currently reacts in 200 ms. Mitigate by having the relay fire on a DynamoDB Streams trigger instead of a schedule — that gives ~1 s latency with the same guarantee — but Streams adds a second event source and its own failure mode (stream shard iterator expiry). Start with the schedule, measure, then decide.
- `TransactWriteItems` costs 2× a plain write per item and is capped at 100 items. For the A-04 site that is one order update + one outbox row = 4 write units. Negligible; but do not put this on `clearCart`'s per-row loop (C-02).
- The outbox table needs a sweeper for rows the relay could never publish (a permanently failing event). TTL handles it after 7 days, but a 7-day-old unpublished event is a silently lost one. Add an alarm on `outbox row age > 5 minutes`.
- For A-02 specifically, the outbox does not solve it — a provider call cannot be inside a DynamoDB transaction. A-02 needs the intent/reserve pattern; the outbox solves the *publish* half. Do not conflate them.

---

## E-04 · The order state machine is implicit, spread over four files, with no single transition table

**Severity & Impact:** **High** — the platform's most important invariant (what status may follow what status) exists only as scattered `if` statements.

**Location:**
- `packages/backend-common/src/dynamo/Order.ts:569-589` (`setOrderStatus`)
- `packages/backend-common/src/dynamo/Order.ts:596-639` (`transitionRiderStatus`)
- `packages/backend-common/src/dynamo/Order.ts:529-567` (`assignRider`)
- `backend/restaurant-service/src/controllers/order.ts` (status guards in the controller)
- `backend/rider-service/src/controllers/consumers.ts` (status guards in the consumer)
- `backend/utils-service/src/controllers/refund.ts` (cancellation, which also touches status)

**The Flaw:**
`setOrderStatus` guards on `paymentStatus = :paid` and nothing else (B-03). `transitionRiderStatus` has its own rules. `assignRider` has its own. The *set* of legal transitions is the union of what five code paths happen to permit, and it is written down nowhere — not in `docs/04-data-model.md` in a normative form, not in code.

At runtime this means:
- A `delivered` order can be moved to `preparing` by an admin tool that calls `setOrderStatus`.
- A `cancelled` order can be re-assigned to a rider, because `assignRider` checks `riderId` is absent, not `status`.
- `refund.ts` cancels an order by writing `status: "cancelled"` directly, bypassing whatever `setOrderStatus` would have done.

None of these are exploits today; all of them become one the moment a second writer exists — which is precisely what the AI agent tier introduces.

**The Fix:**

```ts
// packages/backend-common/src/dynamo/order-state.ts
import type { OrderStatus } from "./order-schema.js";

/**
 * The ONE state machine. Every write to `status` is a transition through
 * this table, and every transition names the actors permitted to make it.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, Actor[]>>> = {
  placed:           { accepted: ["seller"], cancelled: ["customer", "seller", "system"] },
  accepted:         { preparing: ["seller"], cancelled: ["customer", "seller", "system"] },
  preparing:        { ready_for_rider: ["seller"], cancelled: ["customer", "seller", "system"] },
  ready_for_rider:  { assigned: ["system"], cancelled: ["customer", "seller", "system"] },
  assigned:         { picked_up: ["rider"], cancelled: ["system"] },
  picked_up:        { delivered: ["rider"], cancelled: [] },
  delivered:        {},
  cancelled:        {},
};

type Actor = "customer" | "seller" | "rider" | "system";

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return ORDER_TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
}

/** The ConditionExpression that enforces `from` in the database, not in JS. */
export function transitionCondition(to: OrderStatus, actor: Actor): {
  expression: string;
  values: Record<string, string>;
} {
  const froms = (Object.keys(ORDER_TRANSITIONS) as OrderStatus[])
    .filter((from) => canTransition(from, to, actor));

  if (!froms.length) {
    throw Object.assign(new Error(`${actor} may never move an order to ${to}`), { status: 403 });
  }

  // status IN (...) — DynamoDB has no IN for a condition with a dynamic set,
  // so build it explicitly. A single `from` is the common case.
  const expression = froms.length === 1
    ? "#s = :from0"
    : `#s IN (${froms.map((_, i) => `:from${i}`).join(", ")})`;

  return {
    expression,
    values: Object.fromEntries(froms.map((f, i) => [`:from${i}`, f])),
  };
}
```

```ts
// Order.ts — setOrderStatus, fixed
export async function setOrderStatus(
  orderId: string,
  to: OrderStatus,
  actor: Actor,
): Promise<DynamoOrder | null> {
  const { expression, values } = transitionCondition(to, actor);
  const out = await docClient().send(new UpdateCommand({
    TableName: TABLE.orders(),
    Key: { pk: orderPk(orderId), sk: ORDER_SK },
    UpdateExpression: "SET #s = :to, updatedAt = :now",
    ConditionExpression: `attribute_exists(pk) AND ${expression}`,
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ...values, ":to": to, ":now": new Date().toISOString(),
    },
    ReturnValues: "ALL_NEW",
  }));
  return (out.Attributes as DynamoOrder) ?? null;
}
```

**Trade-offs:**
- **This will reject writes that currently succeed.** Every one of them is either a bug or an admin action that needs an explicit `actor`. Run `transitionCondition` in log-only mode first and collect a week of violations. Budget for finding at least a few "oh, the admin tool does that" cases.
- Encoding `actor` in the condition means the caller must know who it is. Controllers have `req.user.role`; consumers have `"system"`. That is a wiring change across five files — real work, but it is the work that makes the state machine true.
- `status IN (...)` with a dynamic set means the `ExpressionAttributeValues` shape varies at runtime. That defeats a naive prepared-statement cache (there is none here) and makes the generated expression harder to read in logs. Log the resolved `froms` alongside.
- Refunds legitimately need to append `refunds` to a `delivered` order without changing `status`. Do not force every write through the transition table — only writes that set `status`. Keep `attachRefundCapped` (A-01) separate and explicit.

---

## E-05 · No distributed tracing, so every failure investigation is log archaeology

**Severity & Impact:** **Medium** — an operational cost, paid on every incident, and the reason several flaws in this document are hard to *observe* rather than hard to *fix*.

**Location:** `[known-gaps §5.4]`. No `xray` plugin in any of the 13 `serverless.yml` files; no `tracingConfig`; no OpenTelemetry SDK in `packages/backend-common` or `pycommon`; no `traceId` in any log line or event envelope.

**The Flaw:**
An order's life touches: `restaurant-service` (create) → Razorpay webhook → `utils-service` (signature verify) → SQS → `paymentConsumer` → `Order.ts` → SNS → `rider-service` (matcher) → SNS → rider clients → `realtime-service` → WebSocket → browser. That is eight hops and three async boundaries.

When a customer says "my order never got a rider", answering it requires correlating CloudWatch log streams across seven log groups, by timestamp, with no shared identifier. The event envelope carries `{event, data}` and nothing else — no `eventId`, no `traceId`, no `causationId`. So there is no join key at all.

This is not a nice-to-have: A-04's dual-write wouldn't have survived a week in production if "did the fanout publish?" were answerable.

**The Fix:**
Two tiers. The cheap one first.

**Tier 1 (this week, ~2 hours): a correlation id in the envelope and in every log line.**

```ts
// packages/backend-common/src/obs/ctx.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestCtx { requestId: string; orderId?: string; eventId?: string }

const store = new AsyncLocalStorage<RequestCtx>();

export const runWithCtx = <T>(ctx: RequestCtx, fn: () => T): T => store.run(ctx, fn);
export const ctx = (): RequestCtx => store.getStore() ?? { requestId: "unbound" };

/** Structured log line. One JSON object per line, always carries the ids. */
export const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) => {
  const c = ctx();
  const line = { level, msg, requestId: c.requestId, orderId: c.orderId, eventId: c.eventId, ...extra };
  // eslint-disable-next-line no-console
  console[level === "info" ? "log" : level](JSON.stringify(line));
};
```

```ts
// controllers/order.ts — every publish carries the id forward
await publishOrderEvent("order:ready_for_rider", readyPayload, {
  eventId: ctx().eventId ?? randomUUID(),
  traceId: ctx().requestId,
});
```

```python
# packages/pycommon/pycommon/obs.py — the Python side reads the same field
import json, logging, uuid

def bind_event(record: dict) -> dict:
    return {**record, "eventId": record.get("eventId") or str(uuid.uuid4())}
```

**Tier 2 (next sprint): X-Ray.** Serverless has first-class support:

```yaml
plugins:
  - serverless-plugin-tracing

provider:
  tracing:
    lambda: true
    apiGateway: true
```

and `AWSXRay.captureAWSv3Client()` around each lazily-created SDK client in `messaging.ts`, `dynamo/client.ts`, and the Python `boto3` clients. Cost: ~$5 per million traces recorded, ~$0.50 per million retrieved. At this platform's volume that is low single-digit dollars.

**Trade-offs:**
- X-Ray on every Lambda adds 1–3 ms of latency and a small cold-start penalty. It is measurable on the 2 s payment poll path only in aggregate.
- `AsyncLocalStorage` in Node 24 is stable and cheap, but it does **not** propagate across the SQS/SNS boundary automatically — the `eventId` must be written into the message body and re-bound in the consumer. That is the actual work; the library is the easy part.
- X-Ray's cost scales with *sampled* requests. The default rule samples 1 req/s plus 5% beyond that. For a low-traffic platform that means nearly everything is traced; for a busy one, almost nothing. Set an explicit sampling rule once traffic justifies it, or you will not have the trace you need on the day you need it.
- Do not adopt a full OpenTelemetry collector stack for this platform. The operational surface (a collector, a backend, retention tuning) exceeds the value at this scale. X-Ray + correlation ids covers it.

---

## E-06 · Compensation exists at exactly one of the three multi-system writes

**Severity & Impact:** **High** — the one correct saga makes the other two look handled.

**Location:**
- Correct: `backend/rider-service/src/controllers/consumers.ts` — `claimRiderForOrder` → `publishRiderEvent` → on `false`, `releaseRiderFromOrder` (defeated by C-11's missing timeout)
- Missing: `backend/utils-service/src/controllers/refund.ts` — provider refund → ledger write (A-02)
- Missing: `backend/restaurant-service/src/controllers/order.ts` — status write → two publishes (A-04)

**The Flaw:**
The rider-accept flow is a genuinely good saga: an atomic claim (`claimRiderForOrder` uses a conditional update), a publication whose failure is *surfaced as a boolean*, and an explicit compensating write. Reading it, you would conclude the codebase understands sagas.

The other two paths contradict that. The refund path writes the ledger *after* moving money and treats failure as a log line. The dispatch path publishes to two transports and treats the second failure as a warning. Neither has a compensation, a retry, or a durable record — the difference from the rider flow is not a design decision, it is that nobody wrote the compensation.

There is a fourth asymmetry worth naming: **`ai-orchestrator` can initiate refunds** (`/api/utils/refund/execute`) and has no compensation either, so the second writer to the money path inherits the first one's gap.

**The Fix:**
Adopt the rider flow's shape as the platform pattern, and state it once in `docs/02-architecture.md`:

> **Rule:** any operation that mutates two systems must (a) claim atomically first, (b) treat publication as fallible and surface the failure, (c) have a named compensating action that is itself idempotent, and (d) leave a durable trace of the fact that compensation ran.

Then apply it:

| Path | Claim | Side effect | Compensation |
|---|---|---|---|
| Rider accept | `claimRiderForOrder` (exists) | publish | `releaseRiderFromOrder` (exists; fix C-11) |
| Refund | `reserveRefund` (A-02, to build) | provider call + ledger | `finalise("failed")` + reconciliation sweep (A-02) |
| Ready-for-rider | status `UpdateItem` with transition condition (E-04) | outbox publish (E-03) | none needed — the outbox *is* the retry |

The third row is the important insight: an outbox replaces the need for a compensation on the publish path, because the publish is retried until it succeeds. Compensation is for effects you cannot retry — a provider refund, an assigned rider.

**Trade-offs:**
- Compensations create *new* states that must be observable: "refund reserved but provider unknown", "rider released after publish". Each needs a reconciliation owner. The hourly `reconcile` job in `utils-service` is the natural home — and it currently has no failure destination (B-08), so it must be fixed first.
- Making publication "fallible" changes signatures. `publishEvent` returning `void` becomes `Promise<boolean>`, which ripples through every call site. That is the cost of the rider flow's correctness; it is worth paying once rather than three times.
- Do not add compensations to paths that do not need them (single-store writes). Over-applying the pattern is how "saga" becomes a synonym for "complicated".

---

## E-07 · The AI agent is a second money-write path guarded only by application code

**Severity & Impact:** **High** — the newest tier in the system can move money, and its guardrails are `if` statements in its own process.

**Location:**
- `backend/ai-orchestrator/src/controllers/` — the agent's action surface, including `POST /api/utils/refund/execute`
- `backend/ai-orchestrator` voucher issuance — `VOUCHER_CAP = 150`, deterministic codes `FOODO-AGENT-<caseId last 8>`
- `backend/utils-service/src/controllers/refund.ts` — the endpoint the agent calls
- `backend/ai-orchestrator/src/tools/actions.ts` — pre-flight `GET /refund/order/:orderId/claim`, then `POST /refund/execute`

**The Flaw:**
The agent tier is an LLM-driven process that can, through tools, issue refunds and vouchers. Its only constraints are:

1. `VOUCHER_CAP = 150` — a constant in `ai-orchestrator`.
2. Amount clamps in the refund controller.
3. The cumulative cap in `refund.ts` — which is the TOCTOU of A-01.
4. The `x-internal-key` header.

So the platform's guardrails on machine-initiated money movement are: an application constant, an application `if`, and a shared secret that defaults to `''` in `utils-service` (A-06). There is no rate limit on the agent's refund path, no independent policy layer, no audit trail beyond the `refunds` list, and no human approval step above any threshold.

The pre-flight/execute gap in `actions.ts` makes it worse: `GET /claim` and `POST /execute` are two separate HTTP calls with an arbitrary network round-trip between them. As A-01 notes, that gap is the window in which a second actor (a human CS agent, another agent run) can slip a refund through.

Compare the design quality elsewhere in the AI tier: `ai-verification` has a `PROVIDER_TIMEOUT_MS`, an `opossum` breaker, a 60 s recheck cooldown, a `MAX_IMAGE_BYTES` allow-list, a prompt-injection fence, and — critically — an explicit decision to **never return 5xx on AI failure** (`status: "unverified", flag: "AI_UNAVAILABLE"`). That is exemplary. The money path has none of it.

**The Fix:**
The guardrail must sit where the money moves, not where the agent thinks. Three layers, all in `utils-service`:

```ts
// utils-service/src/controllers/refund.ts
/** Agent-initiated refunds are capped harder than human ones, and always audited. */
const AGENT_SINGLE_REFUND_MAX = 500;      // INR
const AGENT_DAILY_REFUND_MAX = 5_000;
const AGENT_APPROVAL_THRESHOLD = 1_000;   // above this, a human must approve

async function authoriseAgentRefund(orderId: string, amount: number, actor: string): Promise<boolean> {
  if (actor !== "agent") return true;                       // humans are governed elsewhere

  if (amount > AGENT_SINGLE_REFUND_MAX) return false;

  // Durable, shared counter — NOT an in-process variable.
  const dayKey = `AGENT#${new Date().toISOString().slice(0, 10)}`;
  const out = await docClient().send(new UpdateCommand({
    TableName: TABLE.refundLedger(),                        // reuse the ledger's own table
    Key: { pk: dayKey, sk: "TOTAL" },
    UpdateExpression: "ADD refundedAmount :amt",
    ConditionExpression: "attribute_not_exists(refundedAmount) OR refundedAmount + :amt <= :cap",
    ExpressionAttributeValues: { ":amt": amount, ":cap": AGENT_DAILY_REFUND_MAX },
    ReturnValues: "ALL_NEW",
  })).catch(() => null);

  if (!out) return false;                                   // daily cap hit — deny
  return amount <= AGENT_APPROVAL_THRESHOLD;
}
```

Above the approval threshold, the agent does not refuse — it **escalates**, which the platform is already good at:

```ts
if (!allowed) {
  // Deterministic case id keeps this idempotent across agent retries.
  const caseId = `AGENT-REFUND-${orderId}`;
  await putArbitrationCase({ caseId, orderId, amount, requestedBy: "agent", reason: auditReason, status: "pending_approval" });
  await publishRefundEvent("refund.approval_requested", { orderId, amount, caseId });
  return res.status(202).json({ accepted: false, escalated: true, caseId, message: "A human will review this refund." });
}
```

And collapse the pre-flight/execute gap by making execute take the claim's token:

```ts
// execute now requires the token issued by /claim, and /claim reserves.
// One round trip cannot be interleaved because the reservation already exists.
const reserved = await consumeRefundReservation(orderId, req.body.reservationId);
if (!reserved) return res.status(409).json({ code: "RESERVATION_INVALID_OR_EXPIRED" });
```

**Trade-offs:**
- An escalation path means the agent *cannot* resolve every dispute autonomously, which reduces the tier's value proposition. That is the correct trade for a system without a human in the loop on money — but it is a product decision, not an engineering one. Price it: what percentage of agent refunds exceed ₹1,000?
- The daily counter is a single hot DynamoDB item (`AGENT#<date>/TOTAL`). At agent volumes that is fine; it will become a write-contention point long before it becomes a cost problem. If throughput matters, shard it (`TOTAL#<0..7>`) and sum on read.
- A 202 "escalated" response changes the agent's UX contract. The agent must handle "I cannot do this, a human will" as a *successful* tool call, or it will retry the refund in a loop. Test that path explicitly.
- Deterministic case ids are what make escalation idempotent. Keep them deterministic — a `randomUUID()` here means every agent retry creates a new case and a human sees the same refund 40 times.

---

# What is already good

This section exists because an audit that only lists defects is not calibrated, and because several of these are things most codebases at this stage get wrong. They were verified, not assumed.

**Messaging and eventing**
- **SNS push replaced fanout queues** (`realtime-service`, `ai-dispatch`). The reasoning is documented in the config itself (`ai-dispatch/serverless.yml:184-187`), which is rare and valuable.
- **`ReportBatchItemFailures` on all three SQS mappings** (`paymentConsumer`, `orderReadyConsumer`, `disputeConsumer`). Partial-batch failure is handled correctly; a bad message does not re-deliver the whole batch.
- **`VisibilityTimeout` = 6× the function timeout on every queue** (`PaymentQueue` 180 s / 30 s consumer; `OrderQueue` 180 s / 30 s; `AgentDisputesQueue` 720 s / 120 s). This is the single most commonly botched SQS setting and it is right everywhere here.
- **A DLQ per queue with 14-day retention** and `maxReceiveCount: 5`. No poison-pill loop is possible.
- **`handlePushBatch` rethrows for SNS-sourced records** (`messaging.ts:295-309`) — it correctly understands that SNS retry semantics differ from SQS's and cannot be expressed as `batchItemFailures`.
- **`sendWorkItem` rejects >256 KB with an actionable message** pointing at the S3 claim-check pattern, and warns at the 64 KB billing boundary. The guard is right; only its enforcement is inert (C-10).

**Idempotency**
- **`claimOrderForPayment` uses a conditional `UpdateItem`** as an atomic claim (`Order.ts:757-800`). The design is right; B-05 is about the fallback path, not the claim.
- **Dispatch idempotency via `READY#<orderId>/SEEN` claims** with a TTL, and the claim is *released on failure* (`test_a_failed_run_releases_the_claim_so_the_retry_reprocesses` proves it). That is more sophisticated than most systems at this stage.
- **Webhook dedupe table** with 24 h TTL and a conditional put.
- **Refresh-token rotation with reuse detection that revokes the whole family** (`auth-service/src/controllers/auth.ts`). Textbook, and rarely implemented.
- **Deterministic voucher codes** (`FOODO-AGENT-<caseId last 8>`) — a retried agent run produces the same code rather than a second voucher.
- **Stripe refunds carry an `idempotencyKey`.** (Razorpay's absence is A-03, but the Stripe half shows the intent was right.)

**Resilience**
- **`ai-verification` is the best-engineered tier in the repo.** `PROVIDER_TIMEOUT_MS = 12_000`, `opossum` breaker (`errorThresholdPercentage: 50`, `resetTimeout: 15_000`, `volumeThreshold: 3`), `INTERNAL_TIMEOUT_MS = 3_000`, a 5 MB image cap with a MIME allow-list, a prompt-injection fence, a 60 s recheck cooldown, 90-day evidence TTL with a store that tolerates Cloudinary failure — and it **never returns 5xx on AI failure**, returning `status: "unverified", flag: "AI_UNAVAILABLE"` instead. That last decision is the difference between "AI degraded" and "checkout is down".
- **Isolated egress pools in `ai-verification/src/config/http.ts`** — Pool A (critical, 3 s) and Pool B (background, 8 s) with separate breakers. Bulkheading a dependency's blast radius is advanced and it is done here correctly.
- **`createDynamoRateLimitStore` in `ai-verification/src/config/rate-limit.ts`** — the only *correct* distributed rate limiter in the repo (shared state, not per-container). It exists; the fix for B-12 is to copy it, not invent it.
- **Lazy SDK/docClient singletons** throughout `packages/backend-common/src/dynamo/client.ts` and `messaging.ts`. No client is instantiated inside a handler — the classic serverless cold-start and connection-exhaustion antipattern is absent.
- **The rider-accept compensating rollback** is a real saga with an explicit `boolean` failure signal.

**Security**
- **`isInternal` uses `crypto.timingSafeEqual`** and fails closed on an empty key (`packages/backend-common/src/middlewares/isInternal.ts`).
- **Webhook HMAC verification uses `timingSafeEqual`** rather than `===`.
- **`INTERNAL_SERVICE_KEY` has no fallback in `restaurant-service`, `ai-orchestrator` and `ai-dispatch`**, and `ai-dispatch` documents *why*: *"No fallback, on purpose: pycommon's settings validate at import and raise without a key... Fail at deploy, not on first request."* That is exactly the right reasoning; A-06's fix is to spread this pattern, not invent it.
- **The HTTP API access-log format deliberately excludes cookies and authorisation headers** (`core/serverless.yml:88`), and CORS is absent because traffic is same-origin via CloudFront (`core/serverless.yml:65-66`). Both are correct and both are easy to get wrong.
- **No direct database sharing over the network** — services read shared tables via the SDK, not via each other's connection strings. There is no cross-service DB credential.

**FinOps and infrastructure hygiene**
- **`BillingMode: PAY_PER_REQUEST` on every single table.** No provisioned capacity to mis-size.
- **`logRetentionInDays: 14` on every stack**, plus an explicit `RetentionInDays: 14` on the API Gateway access log group. The CloudWatch "Never Expire" default is the most common silent cost in serverless and it is absent here.
- **`natGateways` defaults to `0`.** Dev genuinely costs nothing for networking. (D-05 is about the prod default and the unused tier, not the dev choice.)
- **TTL on `WebhookDedupeTable`, `ConnectionsTable`, `DispatchStateTable` and `CommerceSessionsTable`**, each with the attribute named correctly — including a comment in `dispatch_service.py:151-154` warning that it must be `expiresAt` or the sweep silently never runs.
- **Sparse GSIs used deliberately** — orders without `riderId` never enter `rider-orders`. Correct use of DynamoDB sparsity.
- **CloudFront reverse proxy for `/api/*` with `Managed-CachingDisabled`** (`apps/web/sst.config.ts`) — same-origin (no CORS, no preflights) without caching authenticated responses. Cheap and correct.
- **arm64 everywhere.** ~20% cheaper per GB-second than x86 for the same workload.

---

# Remediation roadmap

Ordered by risk reduction per unit of effort, not by severity label. The `Effort` column is an engineering estimate for the fix *as described*, excluding review and deploy.

## P0 — this week

These are live money or access-control defects. Each is a small diff.

| # | Issue | Effort | Why now |
|---|---|---|---|
| A-01 | Refund cap TOCTOU | ~4 h | Two concurrent refunds over-refund the order. The fix is one conditional expression. |
| A-02 | Ledger write failure returns 200 | ~6 h | Money leaves with no record, and the cap is then permanently wrong. |
| A-03 | Razorpay idempotency key | ~2 h | A single retry triple-refunds. The Stripe branch already shows the pattern. |
| A-05 | `order:track` / `rider:location` authz | ~4 h | Any customer can watch any rider's GPS and spoof location into any order room. |
| A-06 | Secret fallbacks (`dev-only-change-me`, `''`) | ~1 h | Delete the fallbacks; deploys fail loudly instead of running insecure. |
| B-13 | Socket stale-token reconnect loop | ~3 h | Currently burns a failing `$connect` per tab every 5 s, forever. |

**P0 total: ~20 hours.** Nothing here needs a design discussion.

## P1 — one sprint

Correctness and availability. Several are prerequisites for P0 work landing safely.

| # | Issue | Effort | Dependency |
|---|---|---|---|
| A-04 | `order:ready_for_rider` dual-write | 1 d | Needs E-03's outbox (or a single-transport decision) |
| A-07 | Authorizer accepts any JWT / socket token scope | 4 h | Blocks nothing; unblocks a narrower socket token |
| B-01 | Concurrency caps | 2 h | Config only — `reservedConcurrency` + `maximumConcurrency` |
| B-03 | `setOrderStatus` from-state guard | 6 h | Depends on E-04's transition table |
| B-04 | Blanket `catch(() => null)` | 4 h | Prerequisite for A-01 and B-05 landing safely |
| B-05 | `claimOrderForPayment` unguarded retry | 3 h | |
| B-10 | `tryCatch` 500 + message leak | 2 h | |
| B-12 | Per-container rate limits | 4 h | Copy `createDynamoRateLimitStore` from `ai-verification` |
| D-02 | `IdentitySource` + authorizer TTL | 4 h | Halves authorizer invocations; needs the client header mirror |
| D-04 | DLQ alarms + budget | 3 h | Highest risk-reduction-per-hour in the document |

**P1 total: ~6 days.** This is the sprint that stops the bleeding.

## P2 — opportunistic

Debt that compounds but is not currently causing incidents.

| # | Issue | Notes |
|---|---|---|
| B-02 | `handleSqsBatch` unbounded `Promise.all` | Small chunking change; do it before the AI tier scales |
| B-06 | Realtime `eventConsumer` no filter policy | One config line |
| B-07 | Un-jittered retries | One helper, applied everywhere |
| B-08 | Reconciliation cap + no DLQ | Needs `onError` + a destination |
| B-09 | `isSeller`/`isAdmin` fail open | Latent, not live — fix before it arms |
| B-11 | `restaurant → ai-verification` breaker | Copy the Pool A pattern |
| C-01–C-04 | N+1, transactions, FilterExpression pagination, Scans | Batch as one data-access PR |
| C-05 | `createRider` phone uniqueness | Includes a duplicate-cleanup script |
| C-06 | `ProjectionType: ALL` → `INCLUDE`/`KEYS_ONLY` | **Schedule deliberately** — 5-index migration, needs a window |
| C-07 | Single-page list queries | Fix the rider matcher first (C-08) |
| C-08 | Geohash partitioning | The big one; needs a backfill |
| C-09 | Sequential realtime publishes | Trivial once B-13 is fixed |
| C-10 | `SendMessageBatch` | Depends on the claim-check producer decision (D-01) |
| C-11 | Dead `_timeoutMs` | Prerequisite for relying on the rider rollback |
| C-12 | Frontend polling | **After B-13**, or the order screen regresses |
| C-13 | Duplicated SNS envelope parsing | Needs a test harness in `backend-common` |
| C-14 | Per-container health counters | EMF helper in `pycommon` |
| D-01 | `UploadsBucket` lifecycle | Decide keep-vs-delete first |
| D-03 | Missing PITR | One-line-per-table + a CI assertion |
| D-05 | Unused Cognito + NAT tier | Confirm no prod traffic first |

## P3 — architectural, needs a written decision

Not patchable. Each needs a short design note before anyone writes code.

- **E-01** — `OrdersTable` ACL and the eventual ownership boundary. Start by making the coupling visible (the schema contract file), not by extracting a service.
- **E-02** — collapse the three `isAuth` implementations. The canary plan matters more than the code.
- **E-03** — outbox. Required for A-04; decide schedule-relay vs Streams-relay on measured latency.
- **E-04** — the order state machine. Needs a week of log-only enforcement first.
- **E-05** — tracing. Tier 1 is 2 hours and should be done now; Tier 2 is a sprint decision.
- **E-06** — state the saga rule once and apply it three times.
- **E-07** — agent money-path guardrails. This is a product policy decision (approval threshold) before it is engineering.

---

# Quick-win patch table

Every row below is a change that can be reviewed in under 10 minutes, and each removes a specific failure mode. Ordered by risk-reduction per line changed.

| Change | File | Lines | Fixes |
|---|---|---|---|
| Add `IdentitySource: ["$request.header.Authorization"]` and set `AuthorizerResultTtlInSeconds: 30` | `core/serverless.yml` | 2 | D-02 — halves authorizer invocations |
| `reservedConcurrency: 20` on `dispatchConsumer`, `10` on `paymentConsumer` and `orderReadyConsumer` | 3 `serverless.yml` files | 3 | B-01 — caps the blast radius |
| Add `filterPolicy: { event: [order.*, payment.*, rider.*] }` to realtime `eventConsumer` | `realtime-service/serverless.yml` | 3 | B-06 — stops waking a Lambda for every event |
| Delete `${env:JWT_SECRET, 'dev-only-change-me'}` → `${env:JWT_SECRET}` | 6 stacks | 6 | A-06 — fail at deploy, not at runtime |
| Delete `${env:INTERNAL_SERVICE_KEY, ''}` → `${env:INTERNAL_SERVICE_KEY}` | `utils-service`, `rider-service`, `auth-service`, `admin-service` | 4 | A-06 |
| Add `onError` + `deadLetter` to the `reconcile` schedule | `utils-service/serverless.yml` | 3 | B-08 — a failed sweep leaves a trace |
| Add `PointInTimeRecoverySpecification` to `VouchersTable` and `ReviewQueueTable` | `infra/serverless.yml` | 4 | D-03 — money is recoverable |
| Add six DLQ alarms at `Threshold: 1` | `infra` + 3 service stacks | ~45 | D-04 |
| Add `AWS::Budgets::Budget` at 80% ACTUAL / 100% FORECASTED | `infra/serverless.yml` | ~15 | D-04 |
| `strictNullChecks`-safe guard: `if (!user) return res.status(401)` at the top of `isSeller`/`isAdmin` | `backend-common/src/middlewares/isAuth.ts` | 2 | B-09 — closes the latent fail-open |
| Replace `res.status(500).json({ message: error.message })` with a status-preserving, message-redacting version | `backend-common/src/middlewares/tryCatch.ts` | 4 | B-10 |
| Remove `Authority` fallthrough: mint the socket token with `typ: "socket"` and reject anything that is not `typ: "access"` in the authorizer | `auth-service/src/controllers/socket-token.ts` + `core/src/authorizer.ts` | 4 | A-07 |
| Add `NodeHttpHandler({ connectionTimeout: 1000, requestTimeout: 4000 })` to the SNS and SQS clients | `backend-common/src/aws/messaging.ts` | 4 | C-11 |
| Add jitter: `delay * (0.5 + Math.random() * 0.5)` | every retry helper | ~6 | B-07 |
| Delete the six `staleTime: 0` overrides | `apps/web/src/features/*/api` | 6 | C-12 |
| Add `Limit: 50` + `LastEvaluatedKey` loop to `listAvailableRidersNear` | `packages/backend-common/src/dynamo/Rider.ts` | 12 | C-07 (the acute case) |
| `if (nextCursor) console.warn(...)` on every truncating `Query` | shared helper | 1 | C-07 — makes truncation visible |

The single highest-value row is the `IdentitySource` change: two lines that halve the platform's request-path compute. The single highest-value *risk* row is the six DLQ alarms — without them, every other fix in this document is unobservable in production.

---

# Appendix — findings by dimension

Mapping the user-requested dimensions onto the issue IDs above, so nothing in the brief is left unaddressed.

**1. Architectural & distributed systems flaws**

| Sub-dimension | Findings |
|---|---|
| Polling vs push | **D-06** (the pollers are correct — documented to prevent a wrong refactor), B-06 (an unfiltered push that behaves like a poll), C-12 (client-side polling) |
| Idempotency, dedupe, replay | A-01, A-03, B-05, E-03 (outbox requires idempotent consumers); good: `claimOrderForPayment`, dispatch claims, webhook dedupe, deterministic voucher codes |
| Choreography / saga / cascading failure | A-04, E-06, C-11, B-11 |
| Poison pill / DLQ / VisibilityTimeout | **Good everywhere** (14-day DLQs, `maxReceiveCount: 5`, 6× visibility); bad: B-08 (no failure destination), D-04 (no alarms) |
| Leaky abstractions, cross-service DB, circular deps | E-01 (`OrdersTable` six writers), E-02 (`isAuth` divergence), C-13 (duplicated envelope parsing) |
| Missing ACLs, brittle `common` | E-01, E-02 |
| Dual-write / no outbox | A-02, A-04, E-03 |

**2. AWS FinOps**

| Sub-dimension | Findings |
|---|---|
| Idle / over-provisioned resources | D-02 (per-request authorizer), D-05 (2 NATs, unused Cognito), D-01 (bucket nothing writes to) |
| Missing lifecycle / TTL / log retention | D-01; **good**: 14-day log retention everywhere, TTL on 4 tables |
| Missing batching | C-10 (`sendWorkItem`), C-09 (sequential publishes), C-06 (6× write amplification) |
| Large payloads / claim-check | C-10 (the 64 KB guard is inert), D-01 (the bucket exists but is unused) |
| Cross-AZ / NAT / API Gateway hops | D-02 (an extra Lambda per request), D-05 (NAT with no traffic) |

**3. Concurrency, reliability, failure modes**

| Sub-dimension | Findings |
|---|---|
| Concurrency caps | B-01 (zero anywhere) |
| Unhandled 429 / rate limits | B-12 (per-container counters), E-07 (no cap on the agent refund path) |
| Full-batch re-enqueue | **Good** — `ReportBatchItemFailures` on all three mappings; B-02 (in-batch fan-out still unbounded) |
| Circuit breakers | **Good** in the AI tiers (Pool A/B, opossum); B-11 (the one hop without one) |
| Un-jittered retries / infinite loops | B-07, B-13 (the infinite reconnect), C-11 (retries exceeding the Lambda budget) |
| Backpressure | B-01, D-04 (queue-depth alarm) |

**4. Code-level implementation & performance**

| Sub-dimension | Findings |
|---|---|
| N+1 | C-01 (cart), C-02 (clearCart) |
| Unindexed scans | C-03 (`FilterExpression` + `Limit`), C-04 (three full-table `Scan`s), C-08 (single-partition matching) |
| Client-in-handler / pooling | **Good** — lazy singletons throughout; no violation found |
| Unhandled rejections, leaks, timeouts | C-11 (no request timeout), B-04 (swallowed errors), B-10 |
| Frontend polling / ETags / waterfalls | C-12 (five polled screens, no ETag, `staleTime: 0`) |

**5. Security & multi-tenancy**

| Sub-dimension | Findings |
|---|---|
| Over-permissive IAM | A-06 (fallbacks), B-10 (message leak); **good**: no `*` resource policies found in application roles |
| Unencrypted payloads | D-01 (SSE-S3 rather than KMS — deliberate, documented in the fix); `EventsTopic` has no `KmsMasterKeyId` and queues have no `KmsMasterKeyId` — SNS/SQS default to SSE but not to a CMK |
| Hardcoded env fallbacks | A-06 — `'dev-only-change-me'` in 6 stacks, `''` in 5 more, plus a hardcoded API Gateway URL fallback in `apps/web/sst.config.ts` |
| Secret exposure | A-06, A-07 (the socket token is a full-scope credential), A-05 (cross-tenant realtime data) |
| Multi-tenancy isolation | A-05 (`order:track` joins any room), C-09 (the `restaurant:` room is never joined, so seller isolation is accidental rather than designed) |

---

# How to use this document

- **Do not open one ticket per finding.** The P0 and P1 tables are the actionable units; the individual issues are the detailed specification for each ticket's acceptance criteria.
- **Fix B-04 before A-01 and B-05.** The blanket `catch(() => null)` is what makes the other fixes untestable — you cannot assert a conditional-check failure if the error is swallowed three layers down. B-04 is categorised High, but it is a *prerequisite*, and prerequisites run first.
- **Fix D-04 (alarms) before anything else is deployed.** Every fix here changes failure behaviour. Without DLQ alarms and a budget, you will learn about the new failure modes from customers rather than from CloudWatch.
- **Treat D-06, the "What is already good" section, and the positive notes inside each issue as load-bearing.** They are the record of decisions that were correct, and the reason a future reader should not "simplify" them.
- **The scorecard at the top is dated.** It grades the code as of 2026-10-29. Re-grade it after P1; if Microservice boundaries and Data access are still D after this work, the P2 items are not optional.

---

**End of audit.** 47 findings: 7 Critical, 13 High, 14 Medium, 6 FinOps, 7 Architectural. Every finding cites the file and the code that causes it, and every fix is written against this codebase's own patterns — the Dynamo-based rate limiter, the Pool A/B breakers, the `READY#<id>/SEEN` claims, and the "no fallback, on purpose" discipline are all lifted from what already works here rather than imported from outside.
