# infra/ — Foodo deployment (Serverless Framework v3 + Turborepo)

Three tiers, deployed strictly in order. **Serverless resolves all paths
against the config's directory**, so every stack is self-contained.

```
Tier                Stack name         What it owns
─────────────────────────────────────────────────────────────────────
infra/              foodo-infra        VPC (2 AZs, S3+DDB gateway
                                       endpoints, opt-in NAT), S3
                                       uploads bucket, Cognito pool +
                                       web client, 8 DynamoDB tables,
                                       SNS event bus, SQS work queues
                                       (payment, order) + DLQs

core/               foodo-core-api     Shared HTTP API (single base
                                       URL + CORS) + central JWT
                                       REQUEST authorizer Lambda

backend/<svc>/      foodo-<svc>        One stack per domain service:
                                       auth, restaurant, rider,
                                       admin, utils, realtime —
                                       functions, per-service IAM,
                                       own fan-out queues + SNS
                                       subscriptions + filter
                                       policies, WebSocket API
                                       (realtime)
```

## Deploy

```bash
pnpm deploy:infra      # VPC, S3, Cognito, DynamoDB, SNS, SQS  (rarely changes)
pnpm deploy:core       # shared HTTP API + JWT authorizer      (rarely changes)
pnpm deploy:services   # ALL six service stacks (turbo, parallel)
```

Or everything at once: `pnpm deploy:all`.

Deploy a single service (turbo chains its cached `build` first):

```bash
turbo run deploy --filter=@foodo/auth-service
turbo run deploy --filter=@foodo/restaurant-service -- --stage prod
```

## Secrets (deploy time, never committed)

Pass via environment (or per-service `.env.<stage>` files placed in each
stack's directory): `JWT_SECRET`, `COOKIE_SECRET`,
`INTERNAL_SERVICE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`CLOUDINARY_URL` (restaurant + rider), `FRONTEND_URL`,
`REFRESH_COOKIE_NAME`. Use the **same values across all stacks** in a
stage (the JWT authorizer in core must verify the tokens auth-service
mints).

```bash
STAGE=prod pnpm deploy:all
```

## The central authorizer (core-api)

One REQUEST authorizer (`foodo-jwt`) guards protected routes on the
shared HTTP API. It verifies the app's HS256 access token from the
`session` cookie (cookie-session: base64 JSON with a `jwt` field) or an
`Authorization: Bearer` header, then returns `{ isAuthorized, context }`
(simple responses). It authenticates only — **role checks stay in each
service** (`isSeller` / `isRider` / `isAdmin`).

What is intentionally public at the gateway:

| Surface | Why |
|---|---|
| `/api/auth/*` (register/login/refresh) | token issuance — no access token exists yet |
| `/api/restaurant/{all,nearby,{id}}` GET, `/api/menu-item/all/{id}` GET | anonymous browsing |
| `/api/order/payment/claim/{orderId}` POST | service-to-service, `x-internal-key` |
| `/api/utils/*` | webhook HMAC signatures + controller-validated claims |
| `/health/*` | probes |
| WebSocket `$connect` | JWT verified in-handler |

Gateway denies return **403** (API Gateway simple-response semantics);
in-app guards still return 401 as before.

## Event topology

```
SNS events topic (foodo-infra)
 ├─ filter {rider.order_accepted, rider.order_status_changed,
 │          payment.intent.created}  → foodo-restaurant/...-rider-events
 ├─ filter {rider.order_rejected, order.cancelled, order.delivered}
 │                                   → foodo-rider/...-rider-events
 └─ no filter                        → foodo-realtime/...-emit

SQS work queues (foodo-infra)
 ├─ payment → restaurant paymentConsumer
 └─ order   → rider orderReadyConsumer
```

Each service **owns** its inbound queue, DLQ, and the SNS subscription
(including the queue policy that lets SNS deliver). Work queues stay in
the foundation stack because producers and consumers are different
services.

## What runs where

| Service | Entrypoints (dist/) | Triggers |
|---|---|---|
| auth | `index` | HTTP `/api/auth/*` |
| restaurant | `http`, `paymentConsumer`, `riderEventsConsumer` | HTTP (5 routers) + payment work queue + SNS fan-out |
| rider | `http`, `orderReadyConsumer`, `riderEventsConsumer` | HTTP `/api/rider/*` + order work queue + SNS fan-out |
| admin | `index` | HTTP `/api/admin/*` |
| utils | `http`, `reconciliation` | HTTP `/api/utils/*` + EventBridge `rate(1 hour)` |
| realtime | `wsRouter`, `eventConsumer` | WebSocket `$connect/$disconnect/$default` + SNS fan-out → Management API broadcasts |

Realtime also provisions a `connections` DynamoDB table + WebSocket API
in its own stack. Frontend WS URL: the `foodorealtime-<stage>-WebSocketUrl`
export (wss://…).

## NAT gateways (opt-in)

Nothing runs in the VPC yet, so `params.default.natGateways: 0` (prod:
2, one per AZ). Flip it on in `infra/serverless.yml` when a workload
moves into the private subnets — S3 + DynamoDB gateway endpoints are
already wired to every route table.

## Teardown

```bash
pnpm remove:all        # services FIRST (they own routes on the shared API)
```

Order matters: removing core-api while service routes still exist fails;
removing infra while any stack still reads its exports fails. The
uploads bucket uses `DeletionPolicy: Retain` — delete it manually if
you really mean it.

## Cutover from the old combined stacks

If you previously deployed the old `foodo-core` / `foodo-services`
stacks:

1. `pnpm remove:services`-equivalent on the old stack:
   `cd infra/services && serverless remove` (paths per the old layout) —
   or simply `serverless remove` in the old directories before they were
   deleted in this refactor.
2. The old `foodo-core` data stack kept its tables; the new
   `foodo-infra` stack creates **fresh** tables under new names. Dev
   data (if any) must be migrated manually — there is no in-place
   upgrade.
3. Point the frontend at the new base URL (the
   `foodo-core-api-<stage>-HttpApiUrl` export) and the WS URL from the
   realtime stack.
