# Foodo — Architecture Review & System Design Audit (PRD)

**Auditor role:** Principal Software Architect / Distributed Systems Review
**Scope:** `auth`, `restaurant`, `rider`, `admin`, `realtime`, `utils` services, `frontend` (Next.js 16), RabbitMQ topology, MongoDB data layer, Terraform/ALB infra
**Review basis:** Actual code in the repository (every finding below cites a file)

---

## 1. Executive Summary & Architectural Maturity Score

Foodo is a six-service microservice deployment (auth, restaurant, rider, admin, realtime, utils) with a Next.js frontend, RabbitMQ for async events, MongoDB shared across services, Socket.IO for realtime, and an AWS Terraform setup (EC2 + ALB). The domain split is sensible, and some good instincts exist (durable queues, payment state guard `$ne: "paid"`, conditional rider assignment `riderId: null`).

However, the architecture carries **microservice-shaped code with monolith-era reliability**. Inter-service communication is overwhelmingly synchronous HTTP with no timeouts, no retries, no circuit breakers. The admin service opens a *direct connection to the shared MongoDB database*, bypassing service boundaries entirely. The realtime tier is a single un-scaling Socket.IO node. Delivery of payments is best-effort client-driven rather than provider-webhook-driven. There is no tracing, no correlation IDs, no DLQs, no rate limiting.

**System Maturity Rating (1–10):**

| Dimension | Score | Justification |
|---|---|---|
| Scalability | 3/10 | Stateless HTTP services (good) but shared Mongo (admin direct), single-node Socket.IO with in-memory room state, single RabbitMQ consumer per queue, no read/write splitting, no caching layer. |
| Availability | 3/10 | `/health` exists but is shallow (no dependency checks). No replicas defined, no multi-AZ data. SPOFs: RabbitMQ, single Mongo, single realtime node. Boot-time `await connectRabbitMQ()` can wedge startup. |
| Consistency | 4/10 | Payment marking is idempotent (`$ne: "paid"` guard); rider assignment is guarded (`riderId: null`). But cart clearing / order creation / COD flow are non-transactional across services; consumer failures are swallowed without requeue or DLQ. |
| Fault Tolerance | 2/10 | No timeouts on any axios call (verified across `restaurant/src/controllers/order.ts`, `rider/src/controller/rider.ts`, `utils/src/controllers/payment.ts`). No retries, no circuit breakers, consumers ack on processing error (message loss). |

**Top 3 Critical Failure Points (where it breaks first under load):**

1. **`restaurant` service + its MongoDB under checkout surge.** Every order path runs through this single service — cart, order creation, payment fetch, status updates — with a single default Mongoose connection pool (~10 sockets). One slow query (e.g. the `$near` restaurant lookup without a bounded sort) stalls the pool, and the entire ordering pipeline 503s. This is the revenue path.
2. **RabbitMQ, single non-mirrored node.** `amqp.connect(RABBITMQ_URL)` with one connection and one channel per service (`restaurant/src/config/rabbitmq.ts`, `rider/src/config/rabbitmq.ts`). The channel reference goes stale silently on connection loss; `getChannel()` then returns an unusable object and `publishEvent` throws — payment events and rider-matching events vanish. No publisher confirms, no reconnect logic, no DLQ.
3. **The realtime emit hop in synchronous order paths.** `updateOrderStatus`/`updateOrderStatusRider` fire-and-forget an HTTP POST to realtime for *every* status change (`restaurant/src/controllers/order.ts`). Under write surge, realtime becomes a downstream dependency of order acceptance; no timeout means exhausted sockets pile up in the order service event loop.

---

## 2. Architectural Anti-Patterns & Codebase Red Flags

| File/Component | Observed Pattern | Architectural Risk | Recommended Architectural Pattern |
|---|---|---|---|
| `admin/src/util/collection.ts` | Admin service connects **directly to the shared Mongo database** and queries `restaurants`, `riders`, `users`, `orders` collections raw | Bypasses every service contract; any schema change in auth/restaurant silently breaks admin; duplicate business logic (e.g. "pending = isVerified:false") drifts | Route admin reads through owning services via internal APIs (`GET /internal/...`) or a CQRS read-model that services publish to |
| `restaurant/src/controllers/order.ts` (notifyRealtime) | Synchronous workloads depend on fire-and-forget HTTP to `realtime` for each state change | Adds a hidden sync dependency on the socket tier in the order hot path; no timeout → socket exhaustion; realtime outage degrades order API | Emit via RabbitMQ (`realtime` owns a fanout exchange); order service never calls realtime over HTTP |
| `restaurant/src/config/payment.consumer.ts` | Consumer catches errors, logs, and **never requeues / never nacks**; ack on processing error path (`rider/src/config/orderReady.consumer.ts` does the same) | Payment event lost = order stuck `pending` forever with money taken; silent data loss | Retry with backoff via `nack(requeue)` count limit, then DLQ; poison-pill alerting |
| `utils/src/controllers/payment.ts` (verify endpoints) | Payment success is **client-driven**: browser POSTs the verification result; no provider webhook consumed | Dropped client → order stays unpaid though provider captured funds; also replayable endpoint (verify has no order state check beyond signature) | Consume Razorpay/Stripe **webhooks** as source of truth; client verify becomes UX-only; dedupe on provider event id |
| `utils/src/controllers/payment.ts` (createRazorpayOrder) | Fetches order amount via internal HTTP, then calls provider. No idempotency on Razorpay `receipt` reuse; no server-side reconciliation | Duplicate payment intents on double-click; amount trust gap if internal fetch races an update | Idempotency keys on create; cache the order amount; provider webhook reconciliation job |
| All axios inter-service calls (`rider/src/controller/rider.ts`, `restaurant/src/controllers/order.ts`, `utils/*`) | **No `timeout` set on any call**; some run sequentially in request path (`rider acceptOrder` → restaurant → realtime) | One hung downstream hangs the upstream request thread indefinitely; cascading stalls | Shared internal HTTP client: 2–5s timeout, 2 retries with jitter (safe paths only), circuit breaker (opossum), structured errors |
| `realtime/src/socket.ts` | Socket.IO in one process; rooms (`user:{id}`) are **in-memory**; `cors: "*"` on websocket | Second realtime replica = 50% of users silently miss events; no sticky-session aware LB config; open socket auth surface | Redis adapter (`@socket.io/redis-adapter`), sticky sessions at ALB, restrict CORS to frontend origin |
| `realtime/src/routes/internal.ts` | `/emit` trusts `x-internal-key` header only; **no rate limit, no auth on disconnect/broadcast semantics** | Any service (or SSRF-compromised host) can emit arbitrary events to any room | mTLS or network-segmented internal listener; per-service emit allowlist; rate limit |
| `restaurant/src/index.ts`, `rider/src/index.ts` | Top-level `await connectRabbitMQ()` **before** express app creation; consumer starts regardless; on RabbitMQ outage app never boots (unhandled rejection risk) | RabbitMQ restart = full ordering outage even though the API could serve | Connect async post-listen with retry/backoff; lazy reconnect wrapper around channel |
| `restaurant/src/config/order.publisher.ts` | `getChannel()` may return `undefined` after connection drop; `sendToQueue` fire-and-forget; no publisher confirms | Silent event loss (rider never notified); no way to detect | Channel manager with reconnect + `confirmChannel`; outbox table for guaranteed publish |
| `auth/src/index.ts` (cookieSession) | Session JWT in **client-visible cookie** via cookie-session (contents base64, not encrypted-at-rest server-side); JWT contains full user object | Token tampering surface, can't revoke; growing cookie size | httpOnly signed cookie with minimal claims (sub, role), server-side session revocation list or short TTL + refresh |
| `restaurant/src/controllers/order.ts` (createOrder) | Cart read → order create → (COD) cart delete: 3 round trips, no transaction; distance hard-coded `distance: 5` from client at checkout | Partial failure leaves cart/order inconsistent; rider payout computed from client-supplied distance (`riderAmount = ceil(distance)*17`) | Mongo transaction (order+cart) or outbox; compute distance server-side from saved address coords |
| `restaurant/src/models/Order.ts` | `items.itemId` stored as String (not ObjectId); indexes exist only on `expiresAt` TTL; **no index on `userId`, `restaurantId`, `riderId+status`, `createdAt`** | Every "my orders", "restaurant orders", "rider history" is a collection scan at scale | Compound indexes: `{userId, createdAt:-1}`, `{restaurantId, status, createdAt:-1}`, `{riderId, status, createdAt:-1}` |
| `restaurant/src/controllers/order.ts` (fetchRestaurantOrders) | `limit=0` default → returns **entire** collection to seller dashboard (frontend calls with limit 50 today, but analytics aggregates full set server-side each hit) | Unbounded payload + unbounded aggregation cost per page view | Keyset pagination; precomputed daily rollups (see §4) |
| `rider/src/controller/rider.ts` (acceptOrder) | Rider accept → HTTP assign → then marks rider unavailable; two-phase across services without compensation | Assign succeeds but rider flag update fails → rider double-assignment; race window between availability check and assign | Server-side atomic claim: single `findOneAndUpdate(isAvailable:true → false)` before assign; saga with release compensation |
| `frontend/src/lib/socket.ts` + `realtime` | JWT passed in `handshake.auth.token`; token stored in `sessionStorage` | XSS-readable token; long-lived JWT with no rotation | httpOnly cookie auth for socket handshake (same-site), short-lived socket tokens |
| `terraform/` | One EC2 instance per service (`admin-intance.tf`, `auth-intance.tf`…), single `db-intance.tf` — **no ASGs, no multi-AZ, no replica set** documented | Host loss = service loss; DB loss = total loss | ASGs min 2 per tier, Mongo replica set (3 nodes, multi-AZ), RDS-style backups + PITR |
| `utils/src/index.ts` | `cors()` with **no origin restriction** on the payment + upload service | Any origin can call payment create/verify and file upload endpoints | Lock CORS to frontend origin; consider same proxy path as other services |
| Six services share `express.json({limit:"50mb"})` (restaurant, rider, admin, realtime, utils) | 50 MB JSON bodies accepted everywhere | Trivial DoS amplification; memory spikes per request | 1–2 MB default; large payloads only on the upload route (multipart) |

---

## 3. Scalability & Bottleneck Breakdown

### Compute Tier
- **Stateless ✅ with exceptions.** All HTTP services are horizontally scalable in principle. Exceptions: `realtime` (in-memory rooms + in-process `io` singleton), `restaurant`/`rider` consumers bound to a single RabbitMQ channel (duplicate consumers need prefetch + multiple channels), and seed functions (`seedDemoRestaurant`, `seedDemoRider`, `seedDemoUsers`) running on **every boot** — racy under multi-instance starts.
- **Unmanaged background work:** consumers process one message at a time per service with no `prefetch` tuning, no concurrency, no visibility into queue depth. A backlog (payment spike) grows silently — there is no queue-depth metric or alarm.
- **Top-level await** in service bootstrap couples process lifecycle to dependency startup order.

### Database & Data Layer
- **Shared cluster, no per-service DBs.** Services logically share the `restaurants`/`orders` data domain via HTTP except `admin`, which reads raw. Connection strings default to a single Mongo; no replica set/secondary reads configured anywhere (`mongoose.connect(MONGO_URI)` with defaults → poolSize 5–10 per process).
- **Hot collection: `orders`.** Written by restaurant service, read by restaurant/rider/admin/frontend. Missing indexes (§2) mean scans grow linearly with order count. The admin `/stats` endpoint runs 4 collections × up to 16 queries + 3 aggregations **per page view**, uncached.
- **No caching layer at all.** Menu items, restaurant lists, and nearby-restaurant queries are read-heavy and perfectly cacheable (30–60s TTL would cut DB load >70%).
- **TTL index side effect:** `expiresAt: {expireAfterSeconds: 0}` deletes unpaid orders — good — but TTL monitor runs every 60s and deletes can collide with the payment consumer marking paid (race: paid then deleted if timing aligns; guarded partially by `$ne: "paid"` on update but the *delete* isn't order-aware).

### Network & I/O
- **Chatty order lifecycle:** each rider tap (`picked_up`/`delivered`) triggers 2–4 sequential HTTP calls (status save → 2–3 realtime emits) — all inside the request path.
- **Payload bloat:** orders embed full `deliveryAddress` and item denormalizations (fine), but dashboards fetch full order documents when lists only need 6 fields. No projection, no pagination on several list endpoints (`getMyOrders` unbounded).
- **N+1 (Mongoose populate):** `getCart` populates `itemId` + `restaurantId` per row — acceptable now, becomes a tax at scale; better to project the needed fields only.
- **Image upload path:** rider/restaurant photos go base64-JSON → utils → Cloudinary with `50mb` JSON limits instead of multipart streaming through the proxy.

---

## 4. Advanced System Design Upgrade Roadmap

### Event-Driven & Asynchronous Processing
1. **Standardize on RabbitMQ topic exchanges** (already in place) with per-service queues:
   - `order.lifecycle` exchange: events `order.created`, `order.paid`, `order.ready`, `order.picked`, `order.delivered`, `order.cancelled`.
   - `realtime` consumes everything and owns *all* socket emission (delete the HTTP `/emit` hop).
   - Add **DLQs** (`*.dlq`) with `x-death` headers; consumers `nack(requeue:false)` after 3 attempts; alarm on DLQ depth > 0.
2. **Publisher confirms + outbox.** Wrap `publishEvent` in a confirm channel; for must-not-lose events (payment success, order creation), write an `outbox` document in the same Mongo transaction as the state change, and a relay process publishes outbox → RabbitMQ (classic transactional outbox).
3. **Payment webhooks.** Receive Razorpay/Stripe webhooks as the canonical payment signal (`utils` exposes `/webhooks/razorpay` with signature verification + event-id dedupe). The client verify endpoint becomes best-effort UX. This closes the "money taken, order pending" hole.

### Resilience Patterns (specific placements)
- **Circuit breaker (opossum):** wrap every internal HTTP client — `restaurant→realtime`, `rider→restaurant`, `utils→restaurant`, admin→(all). Half-open probes 1 req/10s.
- **Bulkhead:** separate axios instances (pools) for *critical path* (payment fetch, order create) vs *non-critical* (analytics, realtime emit) so a slow realtime can't consume the payment pool.
- **Rate limiting:** `express-rate-limit` + Redis store on auth (`/login` per-IP+email), on `/api/utils/payment/*`, and on internal `/emit`. ALB WAF rule as second layer.
- **Timeouts everywhere:** 3s default internal, 8s payment-provider calls, enforced today by nothing.
- **Load shedding:** at ALB — 429 above target-group latency SLO; service-level: reject non-critical writes (analytics refresh) first.

### Partitioning & Sharding
- **When:** Mongo write throughput or working set exceeds one replica set (roughly >2k writes/s or >200GB hot data). **How:** shard `orders` on hashed `_id` (or `{userId, createdAt}` for locality on "my orders"), zone by region if multi-region. Before that: add the compound indexes (§2) — they buy 10–50x more headroom than sharding.
- **Read/write split:** enable `readPreference: secondaryPreferred` for admin analytics + seller dashboards; keep writes on primary.
- **Realtime scale-out:** Socket.IO + Redis adapter; ALB sticky sessions by socket handshake cookie; consumers key room emission by `userId % N` if needed later.

### Consistency Guarantees
- **Saga for order placement (COD & online):**
  1. `createOrder` + outbox event in one Mongo transaction.
  2. On `order.paid` → mark paid (idempotent, already guarded) → clear cart (move from consumer into same transactional boundary via outbox compensation) → notify.
  3. Compensation: on payment failed/expired webhook → cancel order, release rider if assigned.
- **Idempotency keys:** `Idempotency-Key` header on `POST /order/new`, `/cart/add`, payment verify; store key → response for 24h (Redis or Mongo TTL).
- **Rider assignment as atomic claim:** `Riders.findOneAndUpdate({_id, isAvailable:true},{isAvailable:false})` *first*; if assign-remote fails → release (existing `/release/internal` becomes the saga compensation). Eliminates the double-accept race window.
- **Distance server-side:** compute haversine(restaurant, address) at order creation; ignore client `distance`.

---

## 5. Prioritized Action Plan

### P0 — Immediate / Blocker (data loss & outage prevention)
1. **Add DLQs + requeue limits to both consumers** (`payment.consumer.ts`, `orderReady.consumer.ts`); never ack-on-error silently. *(prevents money-taken/order-lost)*
2. **Webhook-driven payment confirmation** (Razorpay + Stripe) with signature verify + event dedupe; keep client verify as UX only. *(prevents paid-but-stuck orders)*
3. **Timeouts + circuit breaker on all internal axios calls**; boot-time RabbitMQ connect made non-fatal with lazy reconnect. *(prevents cascading stalls / boot outage)*
4. **RabbitMQ channel manager with reconnect + publisher confirms**; replace raw `getChannel()` usage. *(prevents silent event loss)*
5. **Lock CORS on `utils`** and cap `express.json` at 1MB everywhere except upload route. *(closes payment-endpoint abuse surface)*
6. **Order collection compound indexes** (`userId+createdAt`, `restaurantId+status+createdAt`, `riderId+status+createdAt`). *(prevents brownout as orders grow — cheap, hours of work)*

### P1 — Near-Term (5–10x traffic readiness)
7. Redis cache-aside for menu items, restaurant lists, nearby queries (30–60s TTL, invalidation on write); admin `/stats` cached 60s.
8. Socket.IO Redis adapter + sticky sessions; restrict websocket CORS; move all realtime emission behind the queue (remove `/emit` HTTP from order hot paths).
9. Publisher outbox for payment/order events; internal auth allowlist per service on `/internal/*`; per-service queue consumers with prefetch + horizontal consumer scaling.
10. Keyset pagination + response projections on all list endpoints (`getMyOrders`, `fetchRestaurantOrders`, rider history); move admin reads behind owning services.
11. Saga + idempotency keys on order create / payment verify / cart mutations; server-computed distance & rider payout.
12. Structured logging (pino) + request-id middleware propagated through internal calls; health checks upgraded to dependency-aware (ping Mongo, RabbitMQ, downstream).

### P2 — Strategic / Advanced (zero-downtime & multi-region)
13. Mongo replica set (3 nodes, multi-AZ) with PITR backups; secondary reads for analytics; then hashed sharding on `orders` when write threshold hits.
14. ASGs (min 2) per service tier with ALB health checks on the new deep `/health`; rolling deploys; image scanning in the existing Jenkins pipeline.
15. Multi-region: passive standby region with MongoDB global clusters / continuous backup restore drills; Route53 failover (dns.tf already exists).
16. Distributed tracing (OpenTelemetry → Tempo/Jaeger) with `traceparent` propagation across axios + RabbitMQ headers; SLO dashboards + alerting on queue depth, DLQ depth, p99 order latency.
17. Chaos drills: kill realtime during order flow (validate graceful degradation), partition RabbitMQ (validate outbox/DLQ), primary DB failover (validate replica promotion).

---

### Maturity Trajectory

| Phase | Score | After |
|---|---|---|
| Today | S3 / A3 / C4 / F2 | Current audit baseline |
| P0 done | S4 / A5 / C6 / F5 | No known data-loss paths; deps can't wedge boot or requests |
| P1 done | S6 / A7 / C7 / F7 | 10x traffic survivable; observable; graceful degradation |
| P2 done | S8 / A9 / C8 / F8 | Multi-AZ, zero-downtime, regional failover |
