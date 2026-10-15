# 02 — Architecture

## 1. Topology

```
                        ┌───────────────────────────────────────────┐
                        │  CloudFront (SST / OpenNext)              │
   Browser ────────────▶│  • /api/*  → API Gateway origin (cached  │
                        │             off, cookies forwarded)      │
                        │  • /*      → SSR Lambda / static assets   │
                        │  • wss     → separate WebSocket API       │
                        └──────┬──────────────────────────┬────────┘
                               │ /api/*                  │ wss://
                               ▼                         ▼
                  ┌────────────────────────┐   ┌──────────────────────┐
                  │ API Gateway v2 (HTTP)  │   │ API Gateway v2 (WS)  │
                  │  ONE shared API        │   │ foodo-realtime       │
                  │  + JWT REQUEST authz   │   └──────────┬───────────┘
                  └───┬────────┬───────────┘              │
        authorizer ───┘        │                          │
   (jwt.verify only)           │                          │
                               │                          ▼
   ┌───────────┬───────────┬───┴─────┬───────────┬────────┴────────┐
   ▼           ▼           ▼         ▼           ▼                 ▼
┌────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────┐  ┌──────────┐
│ auth   │ │restaurant│ │ rider  │ │ admin  │ │  utils   │  │ realtime │
│ (HTTP) │ │ (HTTP +  │ │ (HTTP+ │ │ (HTTP) │ │ (HTTP +  │  │ (wsRouter│
│        │ │ 2 SQSCons│ │ 2 SQSC)│ │        │ │ reconcile│  │ + SQS)   │
└────┬───┘ └─────┬────┘ └───┬────┘ └────┬───┘ │ schedule) │  └────┬─────┘
     │           │          │           │      └──────────┘       │
     │           └────┬─────┴───────────┴─────────────┬────────────┘
     │                │                               │
     ▼                ▼                               ▼
┌──────────────────────────────────────────────────────────────┐
│ DynamoDB (8 tables)      SNS topic (events)   SQS (2 work q)  │
│ users restaurants        + 4 per-service SQS queues + DLQs   │
│ riders orders                                              │
│ menuItems carts addresses                                   │
│ webhookDedupe (owned by realtime: connections)               │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Repository layout

```
Foodo/
├── apps/web/                 Next.js 16 frontend (SST / OpenNext)
├── backend/
│   ├── auth-service/         registration, login, refresh, /me, socket-token
│   ├── restaurant-service/   restaurants, menu, cart, orders, addresses + 2 consumers
│   ├── rider-service/        rider KYC, availability, accept, status + 2 consumers
│   ├── admin-service/        verification + platform stats
│   ├── utils-service/        Razorpay, Stripe, webhooks, reconciliation cron
│   └── realtime-service/     WebSocket router + broadcaster consumer
├── core/                     shared HTTP API + JWT authorizer Lambda
├── infra/                    VPC, S3, Cognito, 8 DynamoDB tables, SNS, 2 SQS queues
├── packages/
│   ├── types/                zero-dependency shared types (UserRole, OrderStatus…)
│   └── backend-common/       shared Node-only utils (dynamo repos, aws, middleware)
├── docs/                     this documentation set
└── package.json              turbo + pnpm workspace root
```

Six deployable stacks: `foodo-infra`, `foodo-core-api`, five `foodo-*` services, and
`foodo-web` (SST). Each `backend/*/serverless.yml` is an independent Serverless Framework
stack that **attaches routes to the shared HTTP API by id** — they never create their own
gateway.

---

## 3. Deploy order (this matters)

```
1. infra     → foodo-infra-<stage>        tables, topic, queues, VPC, S3, Cognito
2. core      → foodo-core-api-<stage>     HTTP API + jwtAuthorizer
3. services → foodo-{auth,restaurant,rider,admin,utils,realtime}-<stage>
4. frontend → foodo-web                   CloudFront + Next SSR
```

Root scripts enforce it:

```
pnpm run deploy:infra
pnpm run deploy:core
pnpm run deploy:services
pnpm run deploy:frontend
pnpm run deploy:all      # all four in order
```

Teardown is the exact reverse: services → core → infra.

Every service stack reads the infra + core stack through CloudFormation exports:

```yaml
custom:
  infra:   foodo-infra-${self:custom.stage}
  coreApi: foodo-core-api-${self:custom.stage}
...
httpApi:
  id: ${cf:${self:custom.coreApi}.HttpApiId}
```

This is why infra and core **must** deploy first — a service stack fails to resolve if
the export does not exist.

---

## 4. Service communication model

There are exactly **four** mechanisms. Nothing else is used.

### 4.1 Shared DynamoDB (the consistency point)

Services do **not** call each other to read or mutate shared entities. Orders live in
one table; utils-service claims payment directly against it, admin-service reads it,
rider-service queries it. DynamoDB *is* the consistency boundary, so there are no
cross-Lambda hops, no circuit breakers, and no error mangling between services.

### 4.2 SNS topic — domain + realtime events

One topic, `foodo-infra-<stage>-events`. Every consumer declares its **own** SQS queue
and its **own** `AWS::SNS::Subscription` with a `FilterPolicy` on the `event` message
attribute. This is the correct SNS fan-out pattern: the publisher never knows its consumers.

| Subscriber queue | Filter `event` values |
|---|---|
| `foodo-restaurant-<stage>-rider-events` | `rider.order_accepted`, `rider.order_status_changed`, `payment.intent.created` |
| `foodo-rider-<stage>-rider-events` | `rider.order_rejected`, `order.cancelled`, `order.delivered` |
| `foodo-realtime-<stage>-emit` | *(no filter — everything)* |

Two publisher shapes exist, and the difference is deliberate:

- **`makeFanoutPublisher()`** → `{ event, room, payload }`, fire-and-forget. Errors are
  logged and swallowed. Used for realtime UI pushes where a lost event costs one stale
  panel, never a broken flow.
- **`makeDomainEventPublisher()`** → `{ event, payload }`, returns `true`/`false`.
  Used where a dropped event would strand a rider or lose money, so the caller can
  compensate (roll back a claim, or return 503 so the client retries).

### 4.3 SQS work queues — commands

Two shared queues in infra, consumed **directly** by service Lambdas (no intermediate
trigger queue):

| Queue | Envelope type | Consumer |
|---|---|---|
| `foodo-infra-<stage>-payment` | `{ type: "PAYMENT_SUCCESS", data }` | restaurant `paymentConsumer` |
| `foodo-infra-<stage>-order` | `{ type: "order:ready_for_rider", data }` | rider `orderReadyConsumer` |

Both have `VisibilityTimeout: 180`, `maxReceiveCount: 3`, and a dedicated DLQ.
Batches of 5 with `reportBatchItemFailures: true`, so only failed records redrive.

### 4.4 WebSockets

Browser → realtime service directly. See [09 Realtime](./09-realtime.md).

### 4.5 The one synchronous cross-service HTTP call that remains

`POST /api/order/payment/claim/{orderId}` in restaurant-service, authenticated by the
`x-internal-key` header, exists for the legacy path. **Current utils-service does not
call it** — it claims directly against the shared orders table instead. The route is
kept for compatibility and is publicly reachable at the gateway (no user session), guarded
only by the internal key.

---

## 5. Request lifecycle — a protected call end to end

```
Browser
  │  cookie: session=<base64 cookie-session JSON containing the access JWT>
  ▼
CloudFront  ── /api/* behaviour, TTL 0, all cookies + headers forwarded, no cache
  ▼
API Gateway v2
  ▼
jwtAuthorizer (Lambda, 128 MB)          core/src/authorizer.ts
  │  1. pull `session` cookie → base64-decode → JSON → .jwt
  │  2. fallback: Authorization: Bearer <jwt>
  │  3. jwt.verify(token, JWT_SECRET)
  │  4. require claims.sub
  │  → { isAuthorized: true, context: { sub, role } }
  ▼  (context lands on event.requestContext.authorizer.lambda)
<service Lambda>                        e.g. restaurant-service http handler
  │  serverless-http(app)
  │  cookieSession() → req.session.jwt
  │  express router → isAuth (permissive) → isSeller (role guard) → tryCatch(handler)
  │  handler → DynamoDB via shared repository (warm singleton document client)
  ▼
Response  ── Cache-Control stamped where appropriate → CloudFront → browser
```

Three layers of auth, each with a different job:

1. **Gateway authorizer** — proves a valid, unexpired JWT exists. Rejects before any
   service Lambda is billed. No role logic.
2. **`isAuth` (shared, permissive)** — reconstructs `req.user`. Prefers the
   gateway-verified claims (no re-verification), falls back to decoding the session JWT.
   Accepts legacy token generations.
3. **Role guards** (`isSeller` / `isRider` / `isAdmin`) — in-app role authority. These
   stay in the service because the authorizer deliberately has no role policy.

### Why the authorizer does not cache results

`AuthorizerResultTtlInSeconds: 0`. The identity source is a **full Cookie header**. With
caching, an expired-then-refreshed cookie could be denied, or a fresh one could hit a
cached miss. A 128 MB pure-`jwt.verify` Lambda is cheap enough per request; correctness
beats the micro-optimisation.

### Which routes are public at the gateway

Declared explicitly per stack, because API Gateway picks the **most specific literal**
over `{proxy+}`:

| Stack | Public routes |
|---|---|
| auth | `POST /api/auth/{proxy+}` (register / login / refresh), `GET /health/auth` |
| restaurant | `GET /api/restaurant/all`, `/nearby`, `/{id}`, `GET /api/menu-item/all/{id}`, `POST /api/order/payment/claim/{orderId}`, `GET /health/restaurant` |
| rider | `GET /health/rider` only — the entire `/api/rider/{proxy+}` surface is protected |
| admin | `GET /health/admin` only |
| utils | `POST /api/utils/{proxy+}` **all of it** — webhooks authenticate by provider HMAC, not sessions |
| realtime | n/a (WebSocket `$connect` does its own JWT verification) |

`/api/restaurant/my` and `/api/restaurant/upload-signature` are declared explicitly
*before* `/{id}` in restaurant-service — otherwise they would match the public
`GET /{id}` and skip the authorizer.

---

## 6. Caching strategy

There is **no Redis**. Edge caching replaced it.

| Data | Header | Where set |
|---|---|---|
| Restaurant list / by id | `public, max-age=60, s-maxage=120, stale-while-revalidate=600` | `getAllRestaurants`, `getRestaurantById` |
| Nearby restaurants | `public, max-age=60, s-maxage=60, swr=300` | `getNearbyRestaurants` |
| Menu items | `public, max-age=60, s-maxage=60, swr=300` | `getMenuItems` |
| `GET /restaurant/my` | `private, max-age=5, no-cache` | `getMyRestaurant` |
| Payments, verification writes, webhooks | `no-store` (default / not set) | utils, admin |

CloudFront's `/api/*` behaviour sets `defaultTtl/minTtl/maxTtl = 0` but honours
`Cache-Control` from the origin for GET/HEAD.

---

## 7. Observability

- CloudWatch access logs on the HTTP API stage — JSON with `requestId`, `ip`,
  `requestTime`, `httpMethod`, `routeKey`, `status`, `protocol`, `responseLength`,
  **`authorizerError`** (so a bad token is distinguishable from a bad route).
- Log retention: 14 days everywhere.
- Every Lambda sets `context.callbackWaitsForEmptyEventLoop = false` so containers freeze
  immediately instead of idling on SDK sockets.
- Warm-container singleton clients (DynamoDB document client, SNS client, SQS client,
  Management API client) — never constructed per request.
- `serverless-prune-plugin` keeps the **3** most recent versions of every artifact, so
  rollback is always one version back.

---

## 8. Security posture — summary

| Concern | Control |
|---|---|
| Token theft via XSS | Access JWT is `httpOnly`; socket bootstrap token lives in **memory only**, never `sessionStorage` |
| Refresh token theft | Opaque (not a JWT), `httpOnly`, `secure` in prod, `SameSite=Lax`, `path=/api/auth` only, hashed (SHA-256) at rest |
| Stolen refresh token reuse | Single-use rotation + `revokedAt`; a revoked token returning **burns every session** of that user |
| Credential stuffing | Per-IP flood limiter (20/5 min) **plus** failure-only per-IP+email counter (10 failures/15 min) |
| Privilege escalation | Role never read from client input; it comes from verified claims, and role guards re-check in-app |
| Payment forgery | Only HMAC-signed provider webhooks fulfill; amount comes from the server-side claim, not the request |
| Image namespace escape | Signature covers the folder; folder is fixed server-side per resource |
| DoS via body size | 1 MB global; 10 MB only on the three image-bearing create/update paths; the old 50 MB global was removed as trivial amplification |
| Data leakage in admin | `stripCredentials` removes `password`; `stripKeys` removes `pk`/`sk` before any admin response |
| Order enumeration | `fetchSingleOrder` and `getOrderPaymentStatus` both verify `order.userId === user.id` |