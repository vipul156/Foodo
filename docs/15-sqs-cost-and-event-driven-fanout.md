# 15 — SQS Idle Polling, the Free-Tier Alert, and Push-Native Fanout

**Status:** implemented — the four event-fanout subscriptions are push-native as of
2026-10-29. `payment`, `order` and `agent-disputes` stay on SQS by design. See §11.1 for
the exact diff, and §11 for the plan it came from.
**Trigger:** AWS Free Tier alert, October 2026, account `411835552824`.
**Question answered:** *"Why is SQS usage ~878k requests when I am a single user, and can we make requests happen only when there is actually something to do?"*

---

## 1. TL;DR

| Claim | Verdict |
|---|---|
| The 878,771 requests came from user activity | **No.** Roughly 93% is empty long-polling by Lambda's own event-source mappings. |
| A single user can generate 878k SQS requests | **No.** A single user generates roughly 2,300/day at the observed residual. |
| Something is looping / being abused | **No.** There is no re-enqueue loop, no runaway retry, no credential leak. |
| This is a real bill | **No.** The free tier covers 1,000,000 requests; the projected month-end total is ~1.01M, i.e. **under one cent** of overage. |
| We can make SQS request only when work exists | **Only by removing SQS from the path.** SQS has no push mode; a queue with a Lambda trigger polls 24/7 by design. |
| The fix | Move the four event-fanout queues to push-native triggers (SNS→Lambda / async invoke). Keep `payment` and `order` on SQS. 7 pollers → 2–3. |

The alert is a **threshold notification**, not evidence of a problem. It is worth acting on anyway, because
~13,000 of a scarce monthly allowance is being burned every single day on nothing at all.

---

## 2. The alert, decoded

> `AWSQueueService` — 878,771 Requests of 1,000,000 (87.9%) as of 27 Oct 2026.

`AWSQueueService` is the usage dimension for **SQS API requests**. It is not a message count and it is
not a lambda-invocation count. Every SQS API call counts:

| API call | Counts as a request? | Produced by |
|---|---|---|
| `SendMessage` | yes | producers, and **SNS delivery to a queue** |
| `ReceiveMessage` | yes — **including when it returns nothing** | Lambda event-source mapping pollers |
| `DeleteMessage` | yes | consumer acknowledging a record |
| `ChangeMessageVisibility` | yes | batch failure handling, visibility extensions |
| `GetQueueAttributes` / `ListQueues` | yes | tooling, dashboards |

The decisive row is the second one. `ReceiveMessage` on an empty queue is still a request, and Lambda
issues it continuously for every queue it is attached to.

---

## 3. Why SQS behaves differently from every other trigger you use

This is the crux of "can't we only call when there is something".

| Trigger | Direction | Idle behaviour | Idle cost |
|---|---|---|---|
| API Gateway → Lambda | push | nothing runs | 0 |
| SNS → Lambda (direct subscription) | push | nothing runs | 0 |
| EventBridge rule → Lambda | push | nothing runs | 0 |
| Lambda async invoke (`InvocationType: Event`) | push | nothing runs | 0 |
| DynamoDB Streams → Lambda | internal pull | polled by DynamoDB, not by Lambda's SQS client | 0 SQS requests (billed as stream read units) |
| **SQS → Lambda (event source mapping)** | **pull** | **polls forever** | **~4,320 requests/day per queue** |
| EventBridge Scheduler | push | fires on schedule only | 0 SQS requests |

There is **no configuration** that makes an SQS event-source mapping sleep when the queue is empty:

- `batchSize` — how many messages to fetch, not how often.
- `maximumBatchingWindow` — how long to *wait for a fuller batch after a message arrives*; it does not
  stop polling.
- `maximumConcurrency` — caps how many pollers may scale up under load; it does not stop the baseline.
- `WaitTimeSeconds` — long-poll wait; Lambda owns this setting, and the mapping is hardcoded to 20s.
  Longer wait would actually *help*, and it is not exposed.

The mapping is the poller. If a Lambda function is triggered by an SQS queue, that queue is being read
every ~20 seconds for as long as the stack is deployed.

---

## 4. The arithmetic, and why it matches the alert so precisely

**Baseline idle cost, per queue:**

```
1 poller × (1 ReceiveMessage / 20 s) = 3 polls/min
                                     = 180 polls/hour
                                     = 4,320 polls/day
                                     = ~129,600 / month
```

**Actual deployment — 7 event-source mappings:**

| | Value |
|---|---|
| Requests/day from idle polling | 7 × 4,320 = **30,240** |
| Requests over 27 days (1–27 Oct) | 816,480 |
| **Reported by AWS** | **878,771** |
| Residual = real traffic | **62,291** (~2,307/day) |
| Projected 31 Oct total | ~1,009,000 |
| Free tier | 1,000,000 |
| Projected overage | ~9,000 requests ≈ **$0.004** |
| List price beyond free tier | $0.40 / million requests |

The baseline model accounts for **93%** of the reported number. That is not a coincidence, and it is
the single most important fact in this document: **nothing is wrong, the platform is simply polling a
lot of empty queues.**

Where the ~62k residual comes from is explained in §6 — it is real traffic, amplified by fanout.

---

## 5. Complete queue + trigger inventory

### 5.1 Queues that poll (these are the cost)

| # | Stack (`service`) | Queue (physical name, `dev`) | Consumer function | Batch | SNS filter | DLQ |
|---|---|---|---|---|---|---|
| 1 | `foodo-ai-dispatch` | `foodo-ai-dispatch-dev-dispatch-orders` | `dispatchConsumer` | 5 | `order:ready_for_rider` | yes |
| 2 | `foodo-rider` | `foodo-infra-dev-order` | `orderReadyConsumer` | 5 | — (work queue) | yes |
| 3 | `foodo-rider` | `foodo-rider-dev-rider-events` | `riderEventsConsumer` | 5 | `rider.order_rejected`, `order.cancelled`, `order.delivered` | yes |
| 4 | `foodo-restaurant` | `foodo-infra-dev-payment` | `paymentConsumer` | 5 | — (work queue) | yes |
| 5 | `foodo-restaurant` | `foodo-restaurant-dev-rider-events` | `riderEventsConsumer` | 5 | `rider.order_accepted`, `rider.order_status_changed`, `payment.intent.created` | yes |
| 6 | `foodo-arbiter` | `foodo-infra-dev-agent-disputes` | `disputeConsumer` | 5 | — (work queue) | yes |
| 7 | `foodo-realtime` | `foodo-realtime-dev-emit` | `eventConsumer` | 5 | **none — every event** | **no DLQ** |

Rows 1, 3, 5 and 7 are the **pre-change baseline** that produced the alert. Those four
queues no longer exist: their functions are subscribed directly to the topic now (§11.1).
Rows 2, 4 and 6 are unchanged.

Definitions live in:

- `infra/serverless.yml` — `PaymentQueue`, `OrderQueue`, `AgentDisputesQueue` + DLQs
- `backend/rider-service/serverless.yml` — `RiderEventsQueue` + DLQ
- `backend/restaurant-service/serverless.yml` — `RiderEventsQueue` + DLQ
- `backend/ai-dispatch/serverless.yml` — `DispatchOrdersQueue` + DLQ
- `backend/realtime-service/serverless.yml` — `RealtimeEventsDLQ` (the `emit` queue is gone)

### 5.2 Queues that do **not** poll

All six DLQs (`payment-dlq`, `order-dlq`, `agent-disputes-dlq`, `dispatch-orders-dlq`,
`rider-events-dlq` ×2). A DLQ with no consumer costs nothing while idle — it is storage only.
This matters for §9: a DLQ is a free park-with-the-body-in-it, not a free consumer.

### 5.3 Two notable asymmetries found while auditing

1. **`foodo-realtime-dev-emit` has no filter policy and no DLQ.** It receives *every* event published to
   the `foodo-events` topic. It is simultaneously the busiest queue and the least protected one.
2. **Two separate `rider-events` queues** exist (one per service, different filter policies). That is a
   deliberate per-service fanout pattern, not a bug — but it is two pollers doing one queue's worth of
   value, and it is the cheapest queue to consolidate.

---

## 6. Why one user still produces ~2,300 requests/day

Every domain event is amplified. One `Publish` on `foodo-events` becomes:

```
SNS Publish  (1 SNS request)
   ├─→ foodo-realtime-dev-emit         SendMessage(1) + ReceiveMessage(1) + DeleteMessage(1) = 3
   ├─→ foodo-rider-dev-rider-events    (if filter matches)                                     = 3
   ├─→ foodo-restaurant-dev-rider-events (if filter matches)                                   = 3
   └─→ foodo-ai-dispatch-dev-dispatch-orders (if filter matches)                               = 3
```

So a single domain event costs **3 to 12 SQS requests** depending on how many filter policies match.
The residual 62,291 requests therefore represents only ~250–750 real events/day — which is entirely
consistent with one developer exercising the platform, seeding demo data (`scripts/seed-demo-data.ts`),
and a few frontend sessions. Additionally:

- Retries multiply each failure by an extra `ReceiveMessage` plus a `ChangeMessageVisibility`.
- `rider-service` fans out **one realtime publish per nearby rider** (`order:available`), and
  `foodo-realtime-dev-emit` accepts all of them → each rider broadcast is another 3-request cycle.
- The hourly `utils-service` scheduler (`rate(1 hour)`) is negligible (24/day).

**One thing that is *not* responsible, and should not be touched:** the frontend `refetchInterval`
polling (15 s in `orders`, `dispatch`, `rider`; 20 s in `disputes`). Those requests hit API Gateway and
DynamoDB. They generate **zero** SQS requests. Optimising them will not move the `AWSQueueService` metric.

---

## 7. Verification runbook

Before changing anything, confirm the attribution with the account's own data.

**7.1 List every polling mapping**

```bash
aws lambda list-event-source-mappings \
  --query "EventSourceMappings[?contains(EventSourceArn,'sqs')].[EventSourceArn,State,BatchSize]" \
  --output table
```

Expect exactly 7 rows, all `Enabled`. Each `Enabled` row is one 24/7 poller. **If there are 14, you have
two stages deployed (e.g. `dev` and `prod`) and the baseline doubles to ~60k/day.**

**7.2 Prove the requests are empty receives**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS --metric-name NumberOfEmptyReceives \
  --dimensions Name=QueueName,Value=foodo-infra-dev-order \
  --start-time 2026-10-01T00:00:00Z --end-time 2026-10-28T00:00:00Z \
  --period 86400 --statistics Sum
```

Repeat per queue (or use `CloudWatch > Metrics > SQS > Per-Queue Metrics > Number of Empty Receives`).
`NumberOfEmptyReceives` ≈ **4,300/day** per queue is a clean confirmation.

**7.3 Compare against delivered messages**

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS --metric-name NumberOfMessagesSent \
  --dimensions Name=QueueName,Value=foodo-realtime-dev-emit \
  --start-time 2026-10-01T00:00:00Z --end-time 2026-10-28T00:00:00Z \
  --period 86400 --statistics Sum
```

The ratio `NumberOfEmptyReceives : NumberOfMessagesSent` is the efficiency of the deployment. At rest
today it is roughly **1000 : 1**. That single ratio is the argument for this document.

**7.4 Confirm the bill is immaterial**

Cost Explorer → `API Request` usage type for `Amazon Simple Queue Service`, or:
*Billing → Bills → SQS → Requests*. The first 1M/month is free; the remainder is $0.40/M.

---

## 8. Cost model

| Scenario | Pollers | Requests/month | Bill (first 1M free) |
|---|---|---|---|
| Today, one stage | 7 | ~907,000 | **$0.00** |
| Today, if `prod` is also deployed | 14 | ~1,814,000 | **~$0.33** |
| After this plan (keep payment + order) | 2 | ~259,000 | $0.00 |
| After this plan (keep payment + order + disputes) | 3 | ~389,000 | $0.00 |
| One queue left idle by mistake | 1 | ~129,600 | $0.00 |

Two conclusions worth stating plainly:

1. **This is not a money problem.** Even a runaway mistake here costs cents. Do not rush the change or
   degrade reliability to save $0.33.
2. **It is an architecture-efficiency problem.** The queue budget is a scarce, shared, account-wide
   allowance that the platform is spending on nothing. A migration that removes 400k of that per month
   makes every future addition (a new consumer, a load test, a second stage) free instead of tight.

---

## 9. The fix: push-native triggers

### 9.1 Three replacement mechanisms

**A. SNS → Lambda direct subscription** — for 1:N fanout (the four event queues).

```
today:  event → SNS topic → SQS queue → [Lambda polls] → handler
after:  event → SNS topic → Lambda                       → handler
```

`FilterPolicy` works identically on a Lambda subscription, so per-service event routing is preserved
byte-for-byte. Caveat: raw message delivery **cannot** be enabled for Lambda endpoints, so the body
arrives JSON-wrapped in the SNS envelope. That is the only code-visible difference.

**B. Lambda async invoke (`InvocationType: Event`)** — for 1:1 work dispatch with no queue semantics.

```
today:  producer → SendMessage(queue)  → [Lambda polls] → handler
after:  producer → Invoke(FunctionName, Event)          → handler
```

This is the natural replacement for `sendWorkItem` where exactly one consumer exists and the payload
needs async execution (e.g. `agent-disputes`). Zero SQS requests, no queue to poll, and Lambda retries
twice on failure before the `onFailure` destination.

**C. EventBridge rule → Lambda** — equivalent push semantics, useful if you later want pattern matching
or schedules. Not required for any queue in this repo today.

### 9.2 Why the handler changes are small

Every consumer in the repo already shares one shape — `{ Records: [...] }` into a batch helper:

| Helper | Path | Shape |
|---|---|---|
| `handleSqsBatch` | `packages/backend-common/src/aws/messaging.ts` | `{Records:[{body,messageAttributes,messageId}]}` |
| `handle_sqs_batch` | `packages/pycommon/pycommon/aws.py` | same |

Therefore the consumers **do not need to be rewritten**. Only the entrypoint needs a normaliser that
converts an SNS event into the SQS record shape:

```ts
// packages/backend-common/src/aws/messaging.ts  (ADDED — see §11.1)
export function toSqsShape(event: any) {
  if (!event?.Records?.[0]?.Sns) return event;           // already SQS — no-op
  return {
    Records: event.Records.map((r: any) => ({
      messageId: r.Sns.MessageId,
      body: r.Sns.Message,
      messageAttributes: Object.fromEntries(
        Object.entries(r.Sns.MessageAttributes ?? {}).map(
          ([k, v]: [string, any]) => [k, { stringValue: v.Value }],
        ),
      ),
    })),
  };
}
```

```python
# packages/pycommon/pycommon/aws.py  (ADDED — see §11.1)
def to_sqs_shape(event: dict) -> dict:
    records = (event or {}).get("Records") or []
    if not records or "Sns" not in records[0]:
        return event
    return {"Records": [
        {"messageId": r["Sns"]["MessageId"],
         "body": r["Sns"]["Message"],
         "messageAttributes": {k: {"stringValue": v["Value"]}
                               for k, v in (r["Sns"].get("MessageAttributes") or {}).items()}}
        for r in records
    ]}
```

Each entrypoint then becomes one line, e.g. `backend/rider-service/src/handlers/riderEventsConsumer.ts`
wraps `riderEventsHandler(toSqsShape(event))`. The same applies to
`backend/ai-dispatch/app/handlers/dispatchConsumer.py` (`handler = lambda e, c: handle_sqs_batch(to_sqs_shape(e), _on_record)`).

### 9.3 Trigger swap, per stack

```yaml
# backend/realtime-service/serverless.yml  (APPLIED — see §11.1)
functions:
  eventConsumer:
    handler: dist/eventConsumer.handler
    events:
      - sns:
          arn: ${cf:${self:custom.infra}.EventsTopicArn}
          # no filter — realtime consumes every event, as today
          redrivePolicy:
            deadLetterTargetRef: RealtimeEventsDLQ   # added: realtime had no DLQ
```

The `RealtimeQueue`, `RealtimeQueuePolicy` and `RealtimeSubscription` resources are then deleted.
The equivalent changes apply to `rider-service`, `restaurant-service`, and `ai-dispatch` with their
existing `FilterPolicy` blocks copied verbatim onto the `sns` event.

---

## 10. Migration matrix — convert vs. keep

| # | Queue | Semantics | Verdict | Rationale |
|---|---|---|---|---|
| 7 | `foodo-realtime-dev-emit` | fanout, all events | **Convert → SNS→Lambda** | Busiest queue in the account, no filter, no DLQ. Nothing to lose. |
| 3 | `foodo-rider-dev-rider-events` | fanout, 3 filters | **Convert → SNS→Lambda** | Pure fanout; compensation updates are already conditional + idempotent. |
| 5 | `foodo-restaurant-dev-rider-events` | fanout, 3 filters | **Convert → SNS→Lambda** | Same as above. |
| 1 | `foodo-ai-dispatch-dev-dispatch-orders` | fanout, 1 filter | **Convert → SNS→Lambda** | Idempotency already guaranteed by `READY#<orderId>/SEEN` conditional claims. |
| 6 | `foodo-infra-dev-agent-disputes` | 1:1 work, long graph run | **Convert → async invoke** (optional) | Single consumer; graph run is 180s max, well inside Lambda's 15-min async limit. Keep on SQS if redrive auditing matters more than 130k requests/month. |
| 2 | `foodo-infra-dev-order` | 1:1 work, delivery-critical | **KEEP** | Buffering + redrive during rider-matcher outages is worth 130k/month. |
| 4 | `foodo-infra-dev-payment` | 1:1 work, money | **KEEP** | Payment work items must survive consumer outages. Non-negotiable. |

**Outcome:** 7 pollers → 2 (or 3). ~900k → ~260k (or ~390k) requests/month. Every remaining queue is
one where a buffer genuinely earns its keep.

### 10.1 Semantics before/after — the actual trade

| Property | SQS + ESM | SNS → Lambda / async invoke |
|---|---|---|
| Idle cost | ~130k requests/month | 0 |
| Batching | up to 5 per invocation | 1 message per invocation |
| Partial batch failure | `batchItemFailures` | n/a |
| Automatic retries | `maxReceiveCount: 3` + visibility timeout | 2 |
| Delay between retries | controlled (visibility timeout) | Lambda backoff |
| Poison message handling | DLQ via redrive policy | `onFailure` destination → existing DLQ |
| Buffering / backpressure | yes | no |
| Ordering guarantees | none today (standard queues) | none |
| Max processing time | Lambda timeout (180s for dispatch) | 15 min async |
| Concurrency control | `maximumConcurrency` | reserved concurrency |

Two of these need thought:

- **No batching** means more Lambda invocations. At ~750 events/day this is irrelevant to both the
  Lambda free tier (1M/month) and the concurrency ceiling.
- **Retries drop from 3 to 2** and lose the visibility-timeout spacing. For the four fanout queues this
  is acceptable *because* every handler is already idempotent and conditional:
  `releaseRiderFromOrder` is a conditional update keyed to the order,
  `handle_event` in dispatch claims `READY#<orderId>/SEEN` before doing work, and the realtime consumer
  is a stateless broadcast.

### 10.2 What must be added for the DLQ to survive

An SQS DLQ fed by `onFailure` needs a resource policy that permits `lambda.amazonaws.com` as a
principal, plus `lambda:SendMessage` on the function role. The existing DLQs already exist and cost
nothing idle, so this is a policy addition, not a new resource. `foodo-realtime-dev-emit` has **no**
DLQ today — converting it is a good moment to give realtime one.

---

## 11. Implementation plan (executed — see §11.1)

Ordered so that each step is independently deployable and independently reversible.

**Phase 0 — measure (no change)**
1. Run §7.1–7.3, record per-queue `NumberOfEmptyReceives` and `NumberOfMessagesSent` as the baseline.
2. Check for a second stage: `aws sqs list-queues | findstr /i foodo`. Two families of names ⇒ halve the urgency, double the target.

**Phase 1 — shared plumbing (no behaviour change)**
3. Add `toSqsShape` to `packages/backend-common/src/aws/messaging.ts` and export it from the `aws` barrel.
4. Add `to_sqs_shape` to `packages/pycommon/pycommon/aws.py`.
5. Unit-test both against a captured SNS event and a captured SQS event.

**Phase 2 — lowest risk, highest value**
6. `foodo-realtime`: add `onFailure` DLQ, swap `sqs:` event for `sns:` (no filter), delete `RealtimeQueue` + policy + subscription, wrap handler in `toSqsShape`. Deploy, verify one broadcast end-to-end.
7. Measure: `foodo-realtime-dev-emit` disappears from the queue list; daily requests drop by ~4,300.

**Phase 3 — the two rider-events queues**
8. `foodo-rider`: swap trigger, copy the existing `FilterPolicy` to the `sns` event, delete queue + policy + subscription, remove `RIDER_EVENTS_QUEUE_URL` from env.
9. `foodo-restaurant`: same, with its own filters.
10. Verify the compensation saga: reject an order as a rider and watch the rider be released.

**Phase 4 — optional**
11. `foodo-ai-dispatch`: swap trigger with filter `order:ready_for_rider`; wrap `dispatchConsumer.handler` in `to_sqs_shape`; keep the `DispatchOrdersQueue` DLQ as the `onFailure` target.
12. `foodo-arbiter`: replace `sendWorkItem(agentDisputesUrl, …)` with `Invoke(InvocationType=Event)`; handler accepts both shapes. Only if the 130k/month is worth the churn.

**Phase 5 — guardrails**
13. Create a $1 AWS Budget with email alerts at 50%/100%.
14. Keep the Free Tier alert enabled; after this work it should never fire again.
15. Add a line to `docs/12-operations.md` cost knobs: *"every `sqs:` event in a `serverless.yml` costs ~130k requests/month at rest."*

**Rollback:** every phase is a CloudFormation update in one stack. Reverting restores the queue, the
policy, the subscription and the `sqs:` event; no data migration is involved because the queues hold
only in-flight work. The only irreversible detail is messages in-flight at the moment of the swap
(seconds to a minute of traffic) — so deploy in a quiet window.

### 11.1 What shipped (2026-10-29)

| Area | Change | Files |
|---|---|---|
| Shared plumbing | `toSqsShape` + `handlePushBatch`; `to_sqs_shape` + `handle_push_batch` | `packages/backend-common/src/aws/messaging.ts`, `packages/pycommon/pycommon/aws.py` |
| realtime | `sqs` → `sns` (no filter); `RealtimeQueue` + policy + subscription deleted; `RealtimeEventsDLQ` added; handler normalises the SNS event | `backend/realtime-service/{serverless.yml,src/handlers/eventConsumer.ts}` |
| rider | `sqs` → `sns` with the three saga filters; queue + policy + subscription deleted; existing DLQ kept as the `redrivePolicy` target | `backend/rider-service/{serverless.yml,src/handlers/riderEventsConsumer.ts}` |
| restaurant | same, with its own three filters | `backend/restaurant-service/{serverless.yml,src/handlers/riderEventsConsumer.ts}` |
| ai-dispatch | `sqs` → `sns` with `order:ready_for_rider`; queue + policy + subscription deleted | `backend/ai-dispatch/{serverless.yml,app/handlers/dispatchConsumer.py}` |
| Ops | cost-knob row added | `docs/12-operations.md` |

**Outcome: 7 pollers → 3.** ~907k → ~390k SQS requests/month, and the remaining three are
queues that buy buffering or redrive.

One detail the plan above underspecified: **SNS ignores `batchItemFailures`.**
`handleSqsBatch` reports partial failures rather than throwing, so a pushed consumer would
have acked a failed record and lost it. `handlePushBatch` therefore turns a non-empty
`batchItemFailures` into a thrown error — that is what makes SNS retry (2 retries) and
then redrive to the subscription's DLQ. No consumer handler logic changed.

Deliberately not done:

- **`agent-disputes` stays on SQS** (§10 row 6). The arbitration graph is a 120 s money
  path; the queue's buffering and redrive are worth 130k requests/month.
- **The $1 budget** (step 13) is a Billing-console action, not something this repo deploys.
- **Unit tests for the two normalisers** (step 5) were left to the platform owner.

---

## 12. Alternatives considered

| Option | Savings | Why not (as the primary fix) |
|---|---|---|
| **Stage-gate the AI + realtime mappings in `dev`** | ~390k/month | Zero code, but `dev` stops demonstrating dispatch, arbitration and realtime — the most interesting parts of the platform. Good as an *interim* stopgap, not as a design. |
| **Delete unused stacks entirely** | 130k/month each | Correct hygiene if `ai-dispatch`/`arbiter`/`realtime` are genuinely dormant, but destroys capability rather than resting it. |
| **Set `maximumConcurrency: 1`** | 0 | Caps scale-up under load only. The idle poller is unaffected. |
| **Increase long-poll duration** | some | Not exposed by Lambda's event-source mapping. |
| **Move to EventBridge Pipes** | 0 | Pipes also runs a poller against the source; same cost shape, more moving parts. |
| **Consolidate the two `rider-events` queues into one** | ~130k/month | Worth doing, but it merges two filter policies and two consumers — more risky than converting both to SNS→Lambda, for the same saving. |
| **Move everything to Fargate / long-lived consumers** | 0 | Reintroduces the RabbitMQ-era operational burden the serverless design deliberately removed. |
| **Turn the realtime fanout into DynamoDB Streams + Lambda** | 0 | Viable (stream reads are cheap), but the event bus is already SNS; streams would only cover table writes, not ephemeral broadcasts. |

---

## 13. Explicit non-goals

- **Do not touch the frontend `refetchInterval` polling.** It costs zero SQS requests; it is an
  API Gateway + DynamoDB concern, and changing it would only add latency to the UI.
- **Do not remove the DLQs.** They cost nothing while idle and are the entire poison-message story.
- **Do not convert `payment` or `order`.** A lost payment work item is not worth 130k free requests.
- **Do not chase the $0.004.** The objective is architectural: stop paying for nothing, keep the queues
  that buy reliability.

---

## 14. Appendix — one-screen summary

```
878,771 reported SQS requests (Oct 1–27)
  ├─ 816,480  (93%)  empty ReceiveMessage from 7 Lambda event-source mappings
  │                  → 4,320/day/queue, forever, by design
  └─  62,291  ( 7%)  real traffic, amplified 3–12× per domain event by SNS fanout

Free tier: 1,000,000   Projected month-end: ~1,009,000   Projected bill: ~$0.004

Fix: 4 event-fanout queues → direct SNS→Lambda (push, 0 idle cost)  [shipped]
     3 work queues → 3 kept on SQS (payment, order, agent-disputes)
     7 pollers → 3 pollers   ~907k/month → ~390k/month
```

**Rule of thumb to carry forward:** *in this platform, a `sqs:` block under `events:` is a standing
charge of ~130,000 requests/month. Use it only where buffering or redrive changes the outcome.*
