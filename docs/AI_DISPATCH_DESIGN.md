# AI Systems Design — Aegis-Dispatch: Autonomous Dispatch Swarm

**Foodo Platform — Multi-Agent Dispatch & Kitchen Orchestrator**
Status: Implemented on branch `feature/visual-verification`
Service: `ai-dispatch` (port 3010, Python 3.14 / FastAPI / LangGraph / aio-pika)

> Companion doc to `docs/AI_COMMERCE_DESIGN.md` (conversational ordering)
> and `docs/AI_SYSTEMS_DESIGN.md` (visual verification + refund
> arbitration). Same architectural law throughout the platform:

**Agents predict and propose; deterministic policy decides; the platform's
atomic guards own state transitions; every step is traced.**

---

## 1. Executive summary

The platform's original dispatch flow was a single static rule: when an
order flips to `ready_for_rider`, the rider service finds available riders
within 10 km and socket-broadcasts an offer. `ai-dispatch` replaces that
reflex with a **multi-stage prediction-and-allocation swarm** while
keeping the rider-claim as the atomic assignment guard:

```
   [ Restaurant: Order ready_for_rider ]
                     │
                     ▼  order.events (fanout — NEW; legacy ORDER_QUEUE untouched)
   ┌──────────────────────────────────────────────────────────────┐
   │           Aegis-Dispatch Swarm (LangGraph :3010)             │
   │                                                              │
   │   validate → kitchen.predict → fleet.snapshot                │
   │                   │                │                         │
   │                   ▼                ▼                         │
   │            weather.reflex → batching.pair → DECIDE           │
   │            (Open-Meteo)     (VRP-lite)    (pure policy)      │
   │                                    │                         │
   │                                    ▼                         │
   │                                  act                         │
   └──────────────┬───────────────────────────────┬───────────────┘
                  │                               │
                  ▼                               ▼
     [ dispatch.events fanout ]        [ Targeted rider offers ]
       decisions + thought graph        via realtime /internal/emit
       for analytics/dashboards         (atomic rider-claim guards)
                  │
                  ▼
     [ Live ETA to customer socket room: eta:update ]
```

### The agents

| Agent | Job | LLM? |
|-------|-----|------|
| **Kitchen Load Agent** | Predicts true prep completion from queue depth, dish complexity (biryani vs. beverage), and a historical delay factor | Optional bounded nudge (±40%) |
| **Fleet State Agent** | Ranks nearby riders by proximity + heading alignment (no-backtrack scoring) | No — pure math |
| **Batching / VRP Agent** | Pairs co-located orders (≤500 m pickup, ≤2 km drop) when the SLA delay stays ≤ `BATCH_SLA_PENALTY_S` | No — deterministic geometry |
| **Weather & Congestion Reflex** | Open-Meteo ingestion → ETA pads + surge bumps, cached 10 min per region | No — WMO code table |

---

## 2. Responsibilities & ownership

Owns:

- **Dispatch decisions** (published to `dispatch.events` fanout)
- The **pending pool** (orders with no nearby riders — batching candidates)
- **Idempotency** of order-event processing (Redis SETNX / in-process)
- The surge-signal computation for low-supply situations

Does NOT own:

- **Rider claims** — `rider.acceptOrder`'s atomic
  `isAvailable: true→false` flip remains the only double-assign guard
- **Order state** — restaurant service owns it; the swarm reads via
  internal endpoints and never writes order documents
- **Assignments** — the push-assignment seam
  (`PlatformClient.create_order`) is reserved; today the swarm issues
  targeted offers and the platform's claim path executes

---

## 3. Internal workings

### 3.1 Module map

```
ai-dispatch/
├── app/
│   ├── main.py                    lifespan: Redis? → MessageBus → service
│   ├── core/
│   │   ├── config.py              fail-fast settings (bounds for every knob)
│   │   ├── resilience.py          pools + breakers + tenacity retries
│   │   └── logging.py
│   ├── schemas/dispatch.py        typed contracts for every stage
│   ├── clients/platform.py        kitchen/fleet/realtime/summary clients
│   ├── services/
│   │   ├── dispatch_service.py    MQ intake → graph → outcomes → pool
│   │   ├── mq.py                  aio-pika robust consume + fanout publish
│   │   └── geo.py                 haversine + bearing
│   └── agents/
│       ├── kitchen_agent.py       heuristic + bounded LLM refinement
│       ├── fleet_agent.py         proximity + heading scoring
│       ├── batching_agent.py      SLA-bounded pairing (pure function)
│       ├── weather_agent.py       Open-Meteo + WMO mapping + cache
│       └── dispatch_graph.py      LangGraph machine + DECIDE policy
└── tests/                         25 deterministic tests
```

### 3.2 The graph, stage by stage

1. **validate** — the event is `OrderReadyEvent`-validated at MQ intake;
   a malformed payload is a poison pill (retry → DLQ).
2. **kitchen.predict** — deterministic heuristic:
   `base(18) + items×1.2 + complexity + queue×2`, × delay-factor, clamped
   to [10, 45] minutes. The complexity table maps dish keywords
   (`biryani +8`, `beverage −6`, …). When an LLM is configured it may
   nudge the estimate **within ±40%** — `_parse_nudge` clamps everything
   else to the baseline. Inputs are recorded for replay.
3. **fleet.snapshot** — internal roster from the rider service, filtered
   to `isAvailable ∧ isVerified`, distance-bounded
   (`RIDER_SEARCH_RADIUS_KM`), capped at `MAX_CANDIDATES`, sorted by
   distance. Degraded flag when the roster is unreachable.
4. **weather.reflex** — Open-Meteo current conditions (no API key),
   WMO-code → `{pad_minutes, surge_bump, condition}`, wind > 30 adds more
   pad. Cached 10 min per ~1.1 km cell; breaker-protected; degrades to
   `clear/0/0` and says so in the trace.
5. **batching.pair** — pulls the restaurant's other `ready_for_rider`
   orders (internal endpoint) and runs `evaluate_batch`: pickups ≤ 500 m,
   drops ≤ 2 km, detour minutes ≈ `(gap_pickup + gap_drop) × 2.5`, and
   both orders' delays must stay ≤ `BATCH_SLA_PENALTY_S` (300 s default).
   First valid pairing wins; the proposal is a validated `BatchProposal`.
6. **decide** (pure policy — see §3.3).
7. **act** — targeted offers to the chosen rider(s) over the realtime
   service's `/api/internal/emit` (same channel the rider service
   already uses), `eta:update` with the weather-padded ETA to the
   customer's order room, and the decision envelope on `dispatch.events`.

Every node appends `{node, …, duration_ms, at}` to the trace — the full
thought graph travels with the decision for replay/debugging.

### 3.3 The decision policy (deterministic, explainable)

| State | Decision |
|-------|----------|
| No candidates within radius | **broadcast** + surge (`weather.surge_bump` or `SURGE_SMALL`), SLA risk `high`, order parked in the pending pool for future pairing |
| Candidates exist, no batch | **assign** to top-ranked rider; mode `single` |
| Candidates exist + valid batch | **assign** to top-ranked rider; mode `batch` (proposal attached); companion removed from the pool |

SLA risk tiers from `prep_minutes + rider_eta + weather_pad`:
`< 30 → low`, `< 40 → medium`, else `high`. The LLM is not in this loop —
it cannot decide anything.

### 3.4 Batching trade-off (the VRP question)

"Will batching delay Order A past its SLA?" is answered by a pure
function with three geometric gates and one SLA gate (§3.2 stage 5). The
delay model is deliberately conservative (2.5 min/km of combined
gap ≈ 24 km/h with stops); the `BATCH_SLA_PENALTY_S` bound is the knob
operations tunes. A rejected pairing is silent; an accepted one is
visible in the decision with both delay values.

### 3.5 Weather & congestion reflex

- Source: `api.open-meteo.com` current weather (keyless), 10-minute
  per-cell cache — a metro burst of dispatches costs one upstream call.
- Mapping: WMO code → pad/surge (e.g. drizzle `+5/+8`, heavy rain
  `+18/+30`, storm `+25/+40`, snow tiers, fog tiers), wind > 30 km/h adds
  `+5/+5`.
- The pad feeds **ETAs** (customer promise) and rider offers; the surge
  bump feeds **incentives** on broadcast offers and low-supply events.
- Degraded (network down, breaker open) → `clear/0/0` + `degraded: true`
  in the trace. Dispatch never waits on weather.

### 3.6 Idempotency & pool semantics

- MQ delivery is at-least-once; a Redis `SETNX dispatch:seen:{orderId}`
  (TTL 60 s) guards double-processing (in-process dict fallback for
  single-pod). On graph failure the claim is **released** so the retry
  path (parking-lot redelivery) can reprocess.
- Orders dispatched to nobody go into the **pending pool** and become
  batching companions for later orders at the same restaurant; a batched
  companion is removed from the pool.

---

## 4. Integration with the platform

| Concern | Mechanism |
|---------|-----------|
| Event intake | NEW: `order.events` fanout exchange — the restaurant service's `publishEvent` now **mirrors every order event** onto it (best-effort, non-fatal) while the legacy point-to-point `ORDER_QUEUE` keeps feeding the rider service unchanged. The swarm binds its own durable queue `dispatch.orders` with retry parking-lot + DLQ. |
| Order enrichment | `GET /api/internal/orders/:id/summary` (NEW, internal-key) — item names + drop coordinates for prediction/batching. Data stays owned by the restaurant service. |
| Batch pool | `GET /api/internal/orders/batchable` (NEW, internal-key) — same-restaurant ready orders, capped at 10. |
| Rider offers | Realtime service `/api/internal/emit` (existing) — `order:available` with `dispatch: "broadcast" | targeted` + `surgeIncentive`. |
| Assignment guard | Unchanged: `rider.acceptOrder`'s atomic claim + `restaurant.assignRiderToOrder`'s conditional update. The swarm adds intelligence, not a second writer. |
| Customer ETA | `eta:update` on the `order:{id}` socket room (weather-padded, SLA-risk tagged). |
| Ports | 3010 (next free port after 3009). |

**Reserved seam — push assignment:** `PlatformClient.create_order` marks
the integration point for server-side assignment (an internal
`assignRider` endpoint that reuses `assignRiderToOrder`). Until that
lands, the swarm's targeted offer + the platform's atomic claim is the
path; the decision trace notes `dispatch_mode` either way.

---

## 5. Failure & degradation matrix

| Failure | Behavior |
|---------|----------|
| Rider roster unreachable | Empty `degraded` snapshot → broadcast decision with surge; the legacy rider-service flow is untouched and still offers the order to its own 10 km query |
| Kitchen state unreachable | Heuristic prediction with `degraded: true`, base assumptions |
| Open-Meteo unreachable | `clear/0/0` reflex (`degraded: true`), dispatch proceeds |
| Realtime emit fails | Logged, non-fatal — the legacy broadcast path still ran for the rider service |
| LLM down/unconfigured | Pure heuristic prep times (the nudge is optional by design) |
| RabbitMQ down at boot | `connect_robust` retries with backoff; HTTP ops surface serves `health` independently |
| Poison event | 3 retries (2s/4s/8s parking lot) → DLQ + `[ALERT]` log for manual inspection |
| Duplicate event | Idempotency claim (Redis/in-process) — processed once |
| Graph overrun | `recursion_limit` (24) bounds the machine; the linear topology makes this a safety net |

---

## 6. Security posture

| Vector | Defense |
|--------|---------|
| Internal endpoints | All ops routes + the new restaurant endpoints are `x-internal-key` fail-closed (constant-check parity with Node middlewares) |
| Cross-service data access | No collection reads across services — order facts served by the owner (`/internal/orders/*`) |
| Event forgery | Only the broker-reachable publisher path can inject `order.events`; the swarm validates every payload with Pydantic before any node runs |
| DoS via events | QoS prefetch 10, bounded graph, capped candidate/pool sizes, per-cell weather cache |
| Assignment integrity | The swarm never writes orders or riders; the atomic claim path remains the sole assigner |
| Surge minting | Surge only appears on broadcast/low-supply offers, values come from config bounds; rider payouts still derive from distance, not from swarm output |

---

## 7. Configuration reference (`ai-dispatch/.env`)

```env
PORT=3010
ENVIRONMENT=development
LOG_LEVEL=INFO
INTERNAL_SERVICE_KEY=your-internal-service-key

MONGO_URI=mongodb://localhost:27017/foodo
# REDIS_URL=redis://localhost:6379/0

RESTAURANT_SERVICE_URL=http://localhost:3003
RIDER_SERVICE_URL=http://localhost:3004
REALTIME_SERVICE_URL=http://localhost:3002

RABBITMQ_URL=amqp://localhost
ORDER_EXCHANGE=order.events
DISPATCH_EXCHANGE=dispatch.events
DISPATCH_QUEUE=dispatch.orders

ANTHROPIC_API_KEY=            # optional — kitchen nudge only
ANTHROPIC_MODEL=claude-haiku-4-5

RIDER_SEARCH_RADIUS_KM=10
BATCH_RADIUS_M=500
BATCH_DROP_RADIUS_M=2000
BATCH_SLA_PENALTY_S=300
PREP_BASE_MINUTES=18
PREP_MIN_MINUTES=10
PREP_MAX_MINUTES=45
SURGE_SMALL=10
SURGE_LARGE=25
MAX_GRAPH_STEPS=24
```

Restaurant service addition: `ORDER_EVENTS_EXCHANGE=order.events`
(optional — the default matches).

---

## 8. API reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none (LB probe) | Liveness |
| GET | `/api/dispatch/snapshot` | internal key | Swarm health counters + pending pool |
| POST | `/api/dispatch/simulate` | internal key | Staging tool: run the graph on a synthetic `order:ready_for_rider` payload |

MQ contract (consumer): `{ type: "order:ready_for_rider", data: { orderId,
restaurantId, location } }` — anything else is ignored; malformed
`data` is retried then DLQ'd.

MQ contract (producer, `dispatch.events` fanout):
`{ type: "dispatch.decision", decision: AssignmentDecision, trace: [...], at }`.

---

## 9. Testing

```bash
cd ai-dispatch
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt
INTERNAL_SERVICE_KEY=x .venv/Scripts/pytest tests -q
```

25 deterministic tests: geo math, kitchen heuristic bounds/complexity/nudge
clamping, batching gates (radius, drop distance, SLA), fleet scoring
(heading vs. proximity trade-offs), weather mapping + cache, and the
decision policy table (broadcast/surge, assignment, batch mode, SLA
tiers). The restaurant service's TypeScript changes are covered by
`tsc --noEmit` plus the platform's existing integration paths.

Recommended next: a testcontainers suite for the MQ contract (retry/DLQ
behavior against a real broker), and load tests on the pairing pool under
burst traffic.

---

## 10. Flow walkthrough — two orders, one rider

1. **12:00** Burger Barn marks order A ready → `order:ready_for_rider`
   fans out → the swarm enriches (2× Chicken Burger, drop 1.8 km NE),
   predicts prep n/a (already cooked → floor 10 min), finds 3 riders,
   weather `clear`, no companions yet → **assign** top rider
   (score 0.71, ETA 6.2 min, SLA low) → targeted offer + `eta:update`.
2. **12:01** Burger Barn marks order B ready (drop 300 m from A's) →
   kitchen predicts 12 min (2 items) → fleet snapshot has 2 riders →
   batching pairs B with A? **No** — A is already assigned; the pool only
   holds unassigned orders. B is assigned its own rider.
3. **12:04** Monsoon hits (WMO 65) → weather cache now pads **+18 min**
   and bumps surge **+30**. Order C at Pizza Corner has no riders within
   radius → **broadcast** with `surgeIncentive: 30`, parked in the pool,
   SLA `high` recorded on `dispatch.events` for ops dashboards.
4. **12:06** Order D becomes ready 400 m from Pizza Corner with a drop
   1.2 km from C's → batching pairs C+D (delays 180 s/120 s ≤ 300 s) →
   assign best rider to the **batch**, companion C leaves the pool, one
   rider serves two orders within SLA.
