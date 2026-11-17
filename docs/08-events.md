# 08 — Event Bus & Sagas

## 1. Two buses, two envelopes

Both live in `packages/backend-common/src/aws/messaging.ts`.

### Fan-out (realtime tier) — `{ event, room, payload }`

```ts
makeFanoutPublisher(): (event, room, payload) => Promise<void>
```

Fire-and-forget. SNS errors are logged and **swallowed**. Correct for UI pushes: a lost
event costs one stale panel, never a broken flow.

### Domain (business tier) — `{ event, payload }`

```ts
makeDomainEventPublisher(): (event, payload, _timeoutMs = 5000) => Promise<boolean>
```

Returns `true` on publish, **`false` on failure**. Correct for anything money- or
rider-affecting, because the caller must be able to compensate (roll back a claim, return
503 so the client retries) instead of silently dropping the event.

### Work queue (commands) — `{ type, data }`

```ts
sendWorkItem(queueUrl, type, data)   // throws on failure
```

Sent to SQS, not SNS. `type` rides as a MessageAttribute (so consumers can filter without
deserializing) **and** in the body (so handlers see the exact envelope).

### Consumer skeleton

```ts
handleSqsBatch(event, async (data, raw) => { … })            // SQS work queue
handlePushBatch(event, (batch) => riderEventsHandler(batch)) // direct SNS subscription
```

`handleSqsBatch` parses each record, unwraps `{ type, data }` if present, and returns
`{ batchItemFailures: [...] }` so **only** failed records redrive. Batches of 5.

`handlePushBatch` is the entrypoint for a function the topic invokes **directly**. It
normalises the notification into the SQS record shape (`toSqsShape`) and — because SNS
ignores `batchItemFailures` — re-throws a reported failure, so SNS retries the delivery
and the subscription's `redrivePolicy` parks the poison message in the DLQ. A handler
that swallowed the failure instead would silently ack a lost event.

### Envelope unwrapping (every fan-out consumer uses this)

`toSqsShape` (`to_sqs_shape` in pycommon) sets `body` to the notification's inner
`Message`. Raw message delivery is impossible for Lambda endpoints, so handlers keep the
old guard and stay indifferent to which trigger delivered the record:

```ts
const body  = JSON.parse(record.body);
const inner = body.TopicArn ? JSON.parse(body.Message) : body;
```

---

## 2. Event catalog

| Event | Transport | Publisher | Consumer(s) | Payload |
|---|---|---|---|---|
| `order:new` | SNS fanout | restaurant `createOrder` (COD), `onPaymentSuccess` | realtime → rooms | `{ orderId }` |
| `order:update` | SNS fanout | restaurant `updateOrderStatus`, `cancelOrder`, `onPaymentSuccess`, `emitStatusRealtime` | realtime → rooms | `{ orderId, status }` |
| `order:rider_assigned` | SNS fanout | `onRiderOrderAccepted` → `emitAssignedRealtime` | realtime → rooms | `{ order }` |
| `order:delivered` | SNS fanout | `emitDeliveredRealtime` | realtime → `user:{userId}` | full order |
| `order:available` | SNS fanout | rider `orderReadyHandler` | realtime → `user:{riderUserId}` | `{ orderId, restaurantId }` |
| `rider:location` | direct broadcast | rider `$default` action | realtime → `order:{orderId}` room | `{ orderId, latitude, longitude, at }` |
| `rider.order_accepted` | SNS domain | rider `acceptOrder` | restaurant `riderEventsConsumer` | `{ orderId, riderId, riderUserId, riderName, riderPhone, riderPicture }` |
| `rider.order_status_changed` | SNS domain | rider `updateOrderStatus` | restaurant `riderEventsConsumer` | `{ orderId, riderId }` |
| `payment.intent.created` | SNS domain | utils `attachProviderOrder` | restaurant `riderEventsConsumer` | `{ orderId, provider, providerOrderId }` |
| `rider.order_rejected` | SNS domain | restaurant `onRiderOrderAccepted` (compensation) | rider `riderEventsConsumer` | `{ riderId, riderUserId, orderId }` |
| `order.cancelled` | SNS domain | restaurant `releaseRider` | rider `riderEventsConsumer` | `{ riderId, orderId }` |
| `order.delivered` | SNS domain | restaurant `onRiderStatusChanged` | rider `riderEventsConsumer` | `{ orderId, riderId }` |
| `order:ready_for_rider` | **SQS work item** | restaurant `updateOrderStatus` | rider `orderReadyConsumer` | `{ orderId, restaurantId, location }` |
| `PAYMENT_SUCCESS` | **SQS work item** | utils webhook handlers | restaurant `paymentConsumer` | `{ orderId, paymentId, provider }` |

Note `order.delivered` appears twice: as a **fanout** event (to the customer's socket) and
as a **domain** event (to free the rider). Same name, different transport, different
consumers. Both are needed and they do not collide, because they go through different
subscriptions.

---

## 3. Subscriptions

Every service declares its own **direct Lambda subscription** in its own stack. SNS
pushes; nothing polls, so an idle platform costs zero SQS requests. The DLQ is reached
through the subscription's `redrivePolicy`, not a queue's redrive policy.

### restaurant-service — `foodo-restaurant-<stage>-rider-events`

```yaml
- sns:
    arn: ${cf:foodo-infra-<stage>.EventsTopicArn}
    filterPolicy:
      event: [rider.order_accepted, rider.order_status_changed, payment.intent.created]
    redrivePolicy: { deadLetterTargetRef: RiderEventsQueueDLQ }
```

Serverless generates the subscription **and** the `AWS::SQS::QueuePolicy` that lets
`sns.amazonaws.com` write into `RiderEventsQueueDLQ` — conditioned on
`ArnEquals: aws:SourceArn = <infra EventsTopicArn>`, which is what stops anyone else
delivering into it. The DLQ itself is a plain queue (14-day retention, no consumer).

### rider-service — `foodo-rider-<stage>-rider-events`

```yaml
filterPolicy:
  event: [rider.order_rejected, order.cancelled, order.delivered]
```

Identical DLQ + redrive shape.

### ai-dispatch — `foodo-ai-dispatch-<stage>-dispatch-orders`

```yaml
filterPolicy:
  event: [order:ready_for_rider]
```

Same shape again; the handler's `READY#<orderId>/SEEN` conditional claim is what makes
one-invocation-per-event safe.

### realtime-service — `foodo-realtime-<stage>-events`

**No `FilterPolicy`** — consumes every event, exactly like the old RabbitMQ fanout
exchange binding. It only acts when the envelope has both `room` and `event`, and a
failed broadcast is logged rather than retried (one stale panel, never a stuck flow).

---

## 4. Idempotency — SQS is at-least-once

Every handler is written to be safely re-runnable, and the safety comes from **conditional
DynamoDB updates**, not from deduplication logic:

| Handler | Guard | Redelivery result |
|---|---|---|
| `onPaymentSuccess` | `markOrderPaid` requires `paymentStatus <> paid` | returns `null` → early return, no duplicate notifications |
| `onRiderOrderAccepted` | `assignRider` requires `riderId = null AND status = ready_for_rider AND paymentStatus = paid` | returns `null` → would publish a rejection; harmless because the rider is already assigned |
| `onRiderStatusChanged` | `transitionRiderStatus` requires the exact expected `status` | stale transition → `null`, no-op |
| `onPaymentIntentCreated` | `stampPaymentIntent` requires `paymentStatus <> paid` | `null` → logs `[ALERT][RECONCILE]` |
| `rider.order_rejected` / `order.cancelled` | `releaseRiderFromOrder` keyed to the claimed `currentOrderId` | release once, then no-op |
| `order.delivered` | same, plus `{ orderId, status: "delivered" }` | rider marked delivered, then offline |
| `PAYMENT_SUCCESS` | `markOrderPaid` | no-op |

The pattern is written into the source as a contract: *"Handlers must stay idempotent
(SQS is at-least-once)."*

---

## 5. The order saga — full sequence

### Phase A — order placement

```
Customer  POST /api/order/new
   └─► createOrder (TransactWrite: Put order + Delete cart)     [COD only]
   └─► if COD: order:new → restaurant:{id}
              order:new → user:{ownerId}
              order:update → user:{userId}   status: placed
   └─► if online: order stays paymentStatus=pending, ttl = now + 15 min
```

### Phase B — payment

```
Provider  POST /api/utils/payment/webhooks/{razorpay,stripe}
   └─► signature verified over RAW bytes
   └─► isDuplicateEvent(providerEventId)          → 200 "Duplicate event" if seen
   └─► resolve orderId: notes.orderId → order.receipt → provider API lookup
   └─► publishPaymentSuccess → SQS payment queue
                                     │
Restaurant  paymentConsumer           │
   └─► markOrderPaid(orderId)  ───────────  null ⇒ already paid, stop
   └─► clearCart(order.userId)              ← BEFORE any notification
   └─► order:new      → restaurant:{restaurantId}
   └─► order:new      → user:{restaurant.ownerId}
   └─► order:update   → user:{order.userId}     status: placed
```

Cart is cleared **first** deliberately: any cart refetch triggered by the sockets
immediately below must see an empty cart.

Separately, right after creating the provider intent:

```
utils  attachProviderOrder → SNS payment.intent.created
                             │
Restaurant  riderEventsConsumer
   └─► stampPaymentIntent(orderId, provider, providerOrderId)   [conditional]
```

### Phase C — preparation and rider matching

```
Seller  PUT /api/order/:orderId   status = ready_for_rider
   └─► setOrderStatus (conditional: paymentStatus = paid)
   └─► order:update × 3  (customer, restaurant room, owner)
   └─► sendWorkItem(orderQueue, "order:ready_for_rider",
                     { orderId, restaurantId, location })
                                     │
Rider  orderReadyConsumer           │
   └─► listAvailableRidersNear(lat, lon, 10_000)
   └─► Promise.all(riders.map(r => publishRealtimeEvent(
                                 "order:available", `user:${r.userId}`,
                                 { orderId, restaurantId })))
```

### Phase D — claim (the contested step)

```
Rider  POST /api/rider/accept/:orderId
   ├─ 1. claimRiderForOrder(userId, orderId)         ← LOCAL, atomic, conditional
   │       flips isAvailable=false, sets currentOrderId
   │       null ⇒ 404 "Rider not found or not available"
   │
   ├─ 2. publishRiderEvent("rider.order_accepted", {…})
   │       false ⇒ releaseRiderFromOrder(...) ⇒ 503       ← LOCAL ROLLBACK
   │
                                    │
Restaurant  riderEventsConsumer     │
   └─► assignRider(orderId, payload)                     ← conditional
         ├─ null ⇒ ⚠ COMPENSATION
         │          publishOrderEvent("rider.order_rejected", {riderId, riderUserId, orderId})
         │          log "[COMPENSATE] order … not assignable — rider … release requested"
         │
         └─ ok ⇒ emitAssignedRealtime: order:rider_assigned to FOUR rooms
                 restaurant:{restaurantId}, user:{order.userId},
                 user:{restaurant.ownerId}, user:{riderUserId}

Rider  riderEventsConsumer (rider.order_rejected)
   └─► releaseRiderFromOrder(riderId, orderId, { orderId: null, status: "cancelled" })
         → rider goes available again
```

**The two-sided guard.** The rider flips itself offline *before* publishing, so a
double-click cannot produce two claims. The restaurant's conditional update means only one
rider can ever win the order. If the loser learns they lost, the rejection event frees
them. If the publish itself fails, the rider frees itself locally. **Every path ends with
the rider available again.**

### Phase E — delivery

```
Rider  PUT /api/rider/order/update   { orderId }
   └─► publishRiderEvent("rider.order_status_changed", { orderId, riderId })
   └─► 202 "Order status update queued"     ← NOT applied synchronously
                                    │
Restaurant  riderEventsConsumer     │
   └─► transitionRiderStatus(orderId, riderId)
         rider_assigned → picked_up
         picked_up     → delivered
       └─ picked_up: order:update to customer, restaurant room, owner
       └─ delivered:  emitDeliveredRealtime → order:update ×3, order:delivered → user:{userId}
                     + publishOrderEvent("order.delivered", { orderId, riderId })
                                              │
Rider  riderEventsConsumer (order.delivered)  │
   └─► releaseRiderFromOrder(riderId, orderId, { orderId, status: "delivered" })
         → currentOrderId cleared, isAvailable = true
```

The rider never writes the order. This matters because riders are on flaky mobile
networks: the transition is retried by the event system, not by the phone.

### Phase F — cancellation from anywhere

```
Customer or Seller  PATCH /api/order/:orderId/cancel
   └─► cancelOrder  [conditional: status <> delivered AND <> picked_up]
   └─► if order.status was rider_assigned && order.riderId
         → releaseRider(riderId, orderId) → SNS order.cancelled
   └─► order:update "cancelled" to customer, restaurant room, owner
```

---

## 6. Compensation summary

| Failure | Detection | Compensation |
|---|---|---|
| Rider publish fails | `publishRiderEvent` → `false` | rider service rolls back **locally** (`releaseRiderFromOrder`), returns 503 |
| Order already taken / TTL-swept | `assignRider` → `null` | restaurant publishes `rider.order_rejected`; rider service frees the rider |
| Seller cancels an assigned order | controller sees `rider_assigned` + `riderId` | publishes `order.cancelled`; rider service frees the rider |
| Order delivered | `transitionRiderStatus` → `delivered` | publishes `order.delivered`; rider service frees the rider |
| Lost payment webhook | hourly reconciliation finds `pending` older than 20 min | re-publishes `PAYMENT_SUCCESS` from provider truth |
| Duplicate webhook | `isDuplicateEvent` conditional put fails | returns `200 "Duplicate event"`, nothing published |
| SNS attach lost | `stampPaymentIntent` → `null` | logs `[ALERT][RECONCILE]`; the orphan provider intent is flagged by reconciliation |
| Exhausted retries | SQS `maxReceiveCount: 3` (work queues) / SNS delivery retries (pushed events) | message lands in the queue's **DLQ** (14-day retention) for manual inspection |

---

## 7. Adding a new consumer

No publisher changes are needed — that is the payoff of SNS fan-out:

1. In your service's `serverless.yml`, add a `- sns:` event with the infra topic ARN, a
   `filterPolicy` on `event`, and a `redrivePolicy: { deadLetterTargetRef: <YourDLQ> }`
   pointing at a DLQ resource in the same stack. Serverless writes the queue policy.
2. Add `sns:Publish`? No — consumers need no publish permission at all.
3. Add a handler that calls `handlePushBatch(event, yourHandler)` where `yourHandler` is a
   `handleSqsBatch(...)` body. Do **not** add a queue + Lambda event-source mapping: a
   queue with a trigger polls 24/7 and costs ~130k SQS requests/month at rest
   ([15](./15-sqs-cost-and-event-driven-fanout.md)).
4. Write the handler idempotently. There is no dedupe store — conditional DynamoDB writes
   **are** the dedupe, and it is the only thing that absorbs at-least-once delivery.