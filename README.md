# 🍽️ Foodo — Serverless Food Delivery Platform

**Foodo** is a production-grade, multi-role food delivery platform supporting four user roles — **Customers**, **Restaurant Owners (Sellers)**, **Delivery Riders**, and **Platform Administrators** — deployed entirely on AWS serverless infrastructure.

The platform migrated from a local Node.js/Express + MongoDB + RabbitMQ + Vagrant/EC2 development model to a fully serverless AWS architecture: API Gateway HTTP APIs, Lambda functions (ARM64, Node.js 20), DynamoDB (single-table-per-entity), SNS event fan-out, SQS work queues with DLQs, WebSocket APIs for real-time events, Cognito user pools (provisioned for a future identity migration), and a CloudFront reverse proxy for the Next.js frontend — all wired together through Serverless Framework v3 stacks, deployed in three ordered tiers via Turborepo.

---
<img width="5240" height="2360" alt="foodo-aws-serverless-platform" src="https://github.com/user-attachments/assets/537e1585-fc37-4815-a19f-aaf53a4e2fac" />

<img width="4932" height="2880" alt="foodo-target-architecture-prd-p0-p2-roadmap" src="https://github.com/user-attachments/assets/dd65d3b5-f029-4a6b-910a-8b0d8cb9fe78" />

## 📋 Table of Contents

- [The Shift Story — From Local → Serverless](#-the-shift-story--from-local--serverless)
- [Architecture Overview](#-architecture-overview)
- [Three-Tier Deployment Model](#-three-tier-deployment-model)
- [System Requirements](#-system-requirements)
- [Services Overview](#-services-overview)
  - [1. Auth Service](#1-auth-service)
  - [2. Restaurant Service](#2-restaurant-service)
  - [3. Rider Service](#3-rider-service)
  - [4. Admin Service](#4-admin-service)
  - [5. Utils Service](#5-utils-service)
  - [6. Realtime Service](#6-realtime-service)
  - [7. Frontend](#7-frontend)
- [Service Communication](#-service-communication)
- [Event Topology](#-event-topology)
- [Database Schema Overview](#-database-schema-overview)
- [API Endpoints Reference](#-api-endpoints-reference)
- [Installation & Local Development](#-installation--local-development)
- [Deployment](#-deployment)
- [Cutover from the Old Stacks](#-cutover-from-the-old-stacks)
- [Environment Variables Reference](#-environment-variables-reference)
- [Tech Stack](#-tech-stack)

---

## 🔄 The Shift Story — From Local → Serverless

### Where we started

Foodo originally ran as a set of Node.js/Express microservices behind a shared MongoDB database, coordinated through RabbitMQ for async events and Socket.IO for real-time push. Development happened on a developer machine — sometimes inside a Vagrant-provisioned VM, sometimes directly on a long-lived EC2 instance — with each service binding to its own port and talking to a locally-running MongoDB and RabbitMQ.

The classic local topology looked like:

```
Next.js frontend (port 3000)
  │
  ├──▶ Auth Service      :3000  (Express + Mongoose, MongoDB)
  ├──▶ Restaurant Service :3001 (Express + Mongoose, MongoDB, RabbitMQ)
  ├──▶ Rider Service     :3003 (Express + Mongoose, MongoDB, RabbitMQ)
  ├──▶ Admin Service     :3004 (Express + native MongoDB driver)
  ├──▶ Realtime Service  :3002 (Express + Socket.IO)
  └──▶ Utils Service     :3005 (Express + Razorpay/Stripe, RabbitMQ)
```

Everything shared one MongoDB instance. RabbitMQ carried order-lifecycle events (restaurant → rider, rider → restaurant). Socket.IO pushed status updates to connected browsers. Image uploads went through the Utils service as a proxy. On a developer's machine these were all `node` processes; in production-ish scenarios they lived on an EC2 box, sometimes brought up through a Vagrantfile that provisioned MongoDB, RabbitMQ, and the Node services together.

### Why we changed it

That model carried enough operational burden to keep us from moving fast:

- **Long-lived servers to patch, scale, and monitor.** Each EC2/VM host ran several services; scaling one meant resizing the whole box.
- **Shared MongoDB as a bottleneck and a blast radius.** One database for every service meant a schema slip in one service could affect another, and there was no per-service data boundary.
- **RabbitMQ as a separate cluster to operate.** Message durability, clustering, and failover were on us.
- **Socket.IO on a dedicated always-on process.** Real-time had its own server to keep alive.
- **Multer-based file proxying through Utils.** Bytes flowed through the backend (client → Utils → Cloudinary), which meant the API secret lived wherever the proxy ran and the backend had to stay warm to handle uploads.
- **Stateful, always-on deployment shape.** Promoting a release meant coordinated restarts of several processes.

### Where we are now

The current system is fully serverless on AWS, defined as Infrastructure-as-Code in Serverless Framework v3 stacks and deployed through a Turborepo pipeline. The monolith-of-services-on-a-box shape is gone; every domain is its own stack with its own functions, IAM role, and event wiring. The stateful pieces (MongoDB, RabbitMQ, the Socket.IO server, the upload proxy) have each been replaced by a managed or serverless equivalent.

| What we had | What it became |
|---|---|
| Long-lived Express services on EC2/Vagrant | Lambda functions per domain (ARM64, Node.js 20), individually packaged |
| Shared MongoDB (Mongoose + native driver) | 8 DynamoDB tables (single-table-per-entity) provisioned in the foundation stack; services read/write their own tables via `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` |
| RabbitMQ (event queue + pub/sub) | SQS work queues (payment, order) with DLQs for cross-service transport; SNS topic as the domain event bus with per-service filtered subscriptions |
| Socket.IO on a dedicated server | API Gateway WebSocket API + Lambda handlers (`$connect/$disconnect/$default`) + a per-service `connections` DynamoDB table + an event consumer that broadcasts through the Management API |
| File proxy through Utils service | Signed direct uploads — each owning service (restaurant, rider) generates Cloudinary signatures locally via `@foodo/backend-common`; clients upload bytes straight to Cloudinary. The legacy `POST /api/utils/upload` answers 410 Gone |
| Always-on payment polling / in-process timers | EventBridge Scheduler triggers a `reconcile` Lambda in the utils stack on a fixed rate (≈1 hour) |
| One big app to restart for a release | Per-stack deployments; Turborepo chains each service's cached `build` before `serverless deploy` |

The JWT story also shifted: the app still issues its own HS256 access tokens today (signed with `JWT_SECRET`), but the foundation stack now ships a Cognito user pool + web client, provisioned for the future issuer migration. The central authorizer in the core-api stack verifies the app's own JWT_SECRET tokens now; when auth-service moves to Cognito-issued tokens, the authorizer flips to JWKS verification (or the HTTP API's built-in Cognito authorizer) with no infrastructure changes needed in this stack.

### What didn't change (on purpose)

- The HTTP contract the frontend talks to is still a single base URL with `/api/auth/*`, `/api/restaurant/*`, `/api/rider/*`, `/api/admin/*`, `/api/utils/*`, and `/api/menu-item/*`, `/api/cart/*`, `/api/order/*`, `/api/address/*` — just now served by API Gateway HTTP API + Lambda instead of raw Express ports.
- Auth is still stateless JWT; role checks (`isSeller`, `isRider`, `isAdmin`) still live inside each service rather than at the gateway.
- The domain event vocabulary is still the same (`rider.order_accepted`, `rider.order_status_changed`, `payment.intent.created`, `rider.order_rejected`, `order.cancelled`, `order.delivered`).
- The order lifecycle states are the same (`placed → accepted → preparing → ready_for_rider → rider_assigned → picked_up → delivered | cancelled`).
- The frontend is still a Next.js 16 / React 19 app with Tailwind CSS v4, Shadcn UI, TanStack Query, Zustand.

The surface the app presents to a browser is unchanged; the machinery underneath is now event-driven, stateless, and fully managed.

---

## 🏗 Architecture Overview

```
                          CloudFront (single origin)
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
        /api/*  ─────────▶  API Gateway HTTP API  ───  Next.js (SST / OpenNext)
                           │  (one API for the     │   ws://... → WebSocket API
                           │   whole platform)     │
                           │                       │
         ┌─────────────────┼─────────────────────┘
         │                 │
         ▼                 ▼
  JWT authorizer       Service functions
  (foodo-jwt)         (per domain stack,
         │             ARM64 Node.js 20)
         │
         ▼
  ┌─────────────────────────────────────────────────────────┐
  │  foundation stack (foodo-infra) — reads/writes here     │
  │                                                         │
  │  DynamoDB  users | restaurants | riders | orders |      │
  │            menu-items | carts | addresses | webhook-    │
  │            dedupe                                       │
  │                                                         │
  │  SNS events topic  ──▶  fan-out to every service stack  │
  │                                                         │
  │  SQS queues       payment (DLQ)   order (DLQ)          │
  │                                                         │
  │  S3 uploads bucket (private, CORS, SSE, lifecycle)     │
  │                                                         │
  │  Cognito user pool + web client (future issuer)         │
  │                                                         │
  │  VPC (2 AZs) — NAT opt-in, S3 + DynamoDB gateway ends  │
  └─────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

- **Single shared HTTP API.** One API Gateway v2 HTTP API for the whole platform — the single base URL the frontend uses. Each service stack attaches its routes to that API by `id` and points its protected routes at the shared JWT authorizer. CORS lives on the API because service stacks attach to it by id and cannot extend it.
- **Central REQUEST authorizer.** One Lambda REQUEST authorizer (`foodo-jwt`) guards protected routes on the shared HTTP API. It verifies the app's HS256 access token from the `session` cookie (cookie-session: base64 JSON with a `jwt` field) or an `Authorization: Bearer` header, then returns `{ isAuthorized, context }` (simple responses). It authenticates only — **role checks stay in each service** (`isSeller` / `isRider` / `isAdmin`).
- **Serverless shift from RabbitMQ to SQS + SNS.** SQS work queues replace RabbitMQ for cross-service transport: a message failing `maxReceiveCount` times lands in a DLQ instead of sitting in a retry/parking-lot exchange. SNS replaces RabbitMQ pub/sub as the domain event bus, with per-service filtered subscriptions and queue policies that let SNS deliver.
- **DynamoDB replaces MongoDB.** Every service reads/writes its own table(s) through the AWS SDK v3 (`@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`), with per-service IAM statements scoped to exactly the tables it needs. Each table is single-table-per-entity with a `pk`/`sk` key schema and the indexes each service query path needs.
- **WebSocket API replaces the Socket.IO server.** Realtime is now an API Gateway WebSocket API with `wsRouter` (`$connect/$disconnect/$default`) and an `eventConsumer` that consumes every domain event from an SNS fan-out queue and broadcasts to rooms through the Management API. Connection state lives in a `connections` DynamoDB table with TTL.
- **Signed direct uploads replace the Utils file proxy.** Image bytes go browser → Cloudinary directly; the backend only signs (no byte proxying, no utils-service hop). The `CLOUDINARY_API_SECRET` stays server-side — clients only ever receive `signature`, `timestamp`, `apiKey`, `cloudName`; the signature is bound to the exact server-chosen folder/params.

### What is intentionally public at the gateway

The central authorizer explicitly **does not** guard these surfaces:

| Surface | Why |
|---|---|
| `/api/auth/*` (register/login/refresh) | token issuance — no access token exists yet |
| `/api/restaurant/all`, `/api/restaurant/nearby`, `/api/restaurant/{id}` GET, `/api/menu-item/all/{id}` GET | anonymous browsing |
| `/api/order/payment/claim/{orderId}` POST | service-to-service, `x-internal-key` |
| `/api/utils/*` | webhook HMAC signatures + controller-validated claims |
| `/health/*` | probes |
| WebSocket `$connect` | JWT verified in-handler |

Gateway denies return **403** (API Gateway simple-response semantics); in-app guards still return 401 as before.

---

## 📦 Three-Tier Deployment Model

Three tiers, deployed strictly in order. **Serverless resolves all paths against the config's directory**, so every stack is self-contained.

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

frontend (SST)      foodo-web          Next.js via SST Ion native
                                       OpenNext integration on
                                       CloudFront, with a reverse
                                       proxy origin pointing at the
                                       deployed HTTP API URL
```

### Deploy

```bash
pnpm deploy:infra      # VPC, S3, Cognito, DynamoDB, SNS, SQS  (rarely changes)
pnpm deploy:core       # shared HTTP API + JWT authorizer      (rarely changes)
pnpm deploy:services   # ALL six service stacks (turbo, parallel)
```

Or everything at once: `pnpm deploy:all` (also seeds demo data and deploys the frontend).

Deploy a single service (turbo chains its cached `build` first):

```bash
turbo run deploy --filter=@foodo/auth-service
turbo run deploy --filter=@foodo/restaurant-service -- --stage prod
```

### Teardown

```bash
pnpm remove:all        # services FIRST (they own routes on the shared API)
```

Order matters: removing core-api while service routes still exist fails; removing infra while any stack still reads its exports fails. The uploads bucket uses `DeletionPolicy: Retain` — delete it manually if you really mean it.

---

## 💻 System Requirements

| Tool | Version |
|------|---------|
| Node.js | >= 20 |
| pnpm | >= 10 (package manager + workspaces) |
| AWS credentials | configured (for `serverless deploy`, `sst deploy`) |
| Serverless Framework | v3 (via `serverless` catalog entry) |
| TypeScript | 5.x (shared via workspace catalog) |

Local development against the old shape is still possible (see [Installation & Local Development](#-installation--local-development)), but the canonical production path is serverless.

---

## 🔧 Services Overview

### 1. Auth Service

**Purpose**: User registration, login, refresh, logout, profile, and WebSocket token issuance.

| Property | Value |
|----------|-------|
| Stack | `foodo-auth` |
| Entrypoint | `dist/index.handler` |
| Trigger | HTTP `/api/auth/*` on the shared HTTP API |
| Arm | ARM64, Node.js 20, 512 MB, 15s |
| Database | DynamoDB `users` table (shared foundation table) |
| Event publish | SNS `events` topic (e.g. on registration) |

**Routes (gateway-level)**:

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| POST | `/api/auth/register` | Public | token issuance — no access token yet |
| POST | `/api/auth/login` | Public | token issuance |
| POST | `/api/auth/logout` | JWT (gateway + in-app) | defense in depth |
| GET | `/api/auth/me` | JWT (gateway + in-app) | |
| GET | `/api/auth/socket-token` | JWT (gateway + in-app) | for WebSocket handshake |

`/api/auth/{proxy+}` catches the remaining public auth routes (refresh, etc.).

**Database access**: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query` on the `users` table + its indexes (`email-index`, `refresh-index`). Refresh-token rows carry a per-item `ttl` attribute — DynamoDB sweeps expired sessions automatically.

---

### 2. Restaurant Service

**Purpose**: Restaurant management, menu items, cart operations, order management, payment claim, and rider-event consumption.

| Property | Value |
|----------|-------|
| Stack | `foodo-restaurant` |
| Entrypoints | `dist/http.handler`, `dist/paymentConsumer.handler`, `dist/riderEventsConsumer.handler` |
| Triggers | HTTP (5 routers) + shared payment work queue + own SNS fan-out queue |
| Arm | ARM64, Node.js 20, 512 MB, 15s (30s for consumers) |

**Routes (gateway-level)**:

Public (anonymous browsing + internal payment claim):

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| GET | `/api/restaurant/all` | Public | |
| GET | `/api/restaurant/nearby` | Public | |
| GET | `/api/restaurant/{id}` | Public | |
| GET | `/api/menu-item/all/{id}` | Public | |
| POST | `/api/order/payment/claim/{orderId}` | Public | service-to-service, `x-internal-key` |
| GET | `/health/restaurant` | Public | |

Protected (everything on the five routers — declared explicitly to avoid being caught by the public `/api/restaurant/{id}` GET):

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| GET | `/api/restaurant/my` | JWT | explicit, not caught by `/restaurant/{id}` |
| GET | `/api/restaurant/upload-signature` | JWT | explicit — signed direct upload |
| `*` | `/api/restaurant/{proxy+}` | JWT | |
| `*` | `/api/menu-item/{proxy+}` | JWT | |
| `*` | `/api/cart/{proxy+}` | JWT | |
| `*` | `/api/order/{proxy+}` | JWT | |
| `*` | `/api/address/{proxy+}` | JWT | |

**Event wiring**:

- Publishes to the shared `order` SQS work queue (order ready for rider).
- Publishes to the shared `events` SNS topic.
- Consumes the shared `payment` SQS work queue directly (`paymentConsumer`, batchSize 5, partial batch responses).
- Owns its inbound fan-out queue (`rider-events`) + DLQ + SNS filter subscription for `rider.order_accepted`, `rider.order_status_changed`, `payment.intent.created`.

**Database access**: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query` on `restaurants`, `orders`, `menu-items`, `carts`, `addresses` tables + their indexes.

**Image uploads**: signed direct upload — `GET /api/restaurant/upload-signature` returns Cloudinary signature params (generated locally via `@foodo/backend-common`); clients POST bytes straight to Cloudinary. Legacy multipart `file` on create/update endpoints still works as a fallback (server-side upload via the same signer).

---

### 3. Rider Service

**Purpose**: Rider profile management, order acceptance, delivery lifecycle, order-ready consumption, and rider-event saga compensations.

| Property | Value |
|----------|-------|
| Stack | `foodo-rider` |
| Entrypoints | `dist/http.handler`, `dist/orderReadyConsumer.handler`, `dist/riderEventsConsumer.handler` |
| Triggers | HTTP `/api/rider/*` + shared order work queue + own SNS fan-out queue |
| Arm | ARM64, Node.js 20, 512 MB, 15s (30s for consumers) |

**Routes (gateway-level)**:

The rider router applies `router.use(isAuth, isRider)` — the **entire** `/api/rider` surface is authenticated, so it gets one protected catch-all at the gateway. (Includes rider registration — current app semantics, preserved.)

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| `*` | `/api/rider/{proxy+}` | JWT | entire surface |
| GET | `/health/rider` | Public | |

**Event wiring**:

- Consumes the shared `order` SQS work queue directly (`orderReadyConsumer`, batchSize 5, partial batch responses).
- Owns its inbound fan-out queue (`rider-events`) + DLQ + SNS filter subscription for `rider.order_rejected`, `order.cancelled`, `order.delivered` (saga compensations).

**Database access**: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query` on `riders`, `orders`, `restaurants` tables + their indexes.

**Image uploads**: signed direct upload via `GET /api/rider/upload-signature` (Cloudinary signature generated locally via `@foodo/backend-common`).

---

### 4. Admin Service

**Purpose**: Platform administration — verification of restaurants and riders, plus read access to users/orders as needed.

| Property | Value |
|----------|-------|
| Stack | `foodo-admin` |
| Entrypoint | `dist/index.handler` |
| Trigger | HTTP `/api/admin/*` on the shared HTTP API |
| Arm | ARM64, Node.js 20, 512 MB, 15s |

**Routes (gateway-level)**:

The admin router applies `router.use(isAuth, isAdmin)` — every route requires an authenticated admin, so one protected catch-all covers the whole surface.

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| `*` | `/api/admin/{proxy+}` | JWT | entire surface |
| GET | `/health/admin` | Public | |

**Database access**: `dynamodb:GetItem`, `UpdateItem`, `Query`, `Scan` on `users`, `restaurants`, `riders`, `orders` tables + their indexes. Admin accesses the restaurant and rider tables directly (the old native-driver pattern replaced by SDK v3 queries against the shared foundation tables).

---

### 5. Utils Service

**Purpose**: Payment processing (Razorpay, Stripe), payment reconciliation, and webhook dedupe. File uploads have moved to signed direct uploads — this service no longer proxies bytes.

| Property | Value |
|----------|-------|
| Stack | `foodo-utils` |
| Entrypoints | `dist/http.handler`, `dist/reconciliation.handler` |
| Triggers | HTTP `/api/utils/*` + EventBridge Scheduler (rate(1 hour)) |
| Arm | ARM64, Node.js 20, 512 MB, 15s (256 MB, 120s for reconcile) |

**Routes (gateway-level)**:

Payment webhooks are the source of truth for payment success — they authenticate via provider HMAC signatures (Razorpay/Stripe) over raw bodies, **not** user sessions, so the whole `/api/utils` surface stays public at the gateway. The payment-create endpoints validate order state atomically in-controller.

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| `*` | `/api/utils/{proxy+}` | Public | webhook HMAC + controller-validated claims |
| GET | `/health/utils` | Public | |

**Reconciliation**: an `reconcile` Lambda runs on an EventBridge Scheduler `rate(1 hour)` — replaces the old in-process `setInterval` job. It audits provider-vs-DB payment state using `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `STRIPE_SECRET_KEY`.

**Database access**: `dynamodb:GetItem`, `UpdateItem`, `PutItem`, `Query` on `orders`, `webhook-dedupe` tables. `webhook-dedupe` carries a `ttl` attribute — DynamoDB sweeps processed webhook event ids automatically.

**Event wiring**: publishes to the shared `events` SNS topic; sends messages to the shared `payment` SQS work queue.

---

### 6. Realtime Service

**Purpose**: WebSocket push notifications on API Gateway WebSockets.

| Property | Value |
|----------|-------|
| Stack | `foodo-realtime` |
| Entrypoints | `dist/wsRouter.handler`, `dist/eventConsumer.handler` |
| Triggers | WebSocket `$connect/$disconnect/$default` + SNS fan-out → own SQS queue |
| Arm | ARM64, Node.js 20, 256 MB, 30s |

**Routes (WebSocket API)**:

- `wsRouter` — `$connect` (JWT handshake, auto room joins), `$disconnect` (cleanup), `$default` (client actions: `order:track`, `rider:location`).
- `eventConsumer` — consumes **every** domain event (SNS fan-out via this stack's own SQS queue — no filter policy, same as the old fanout exchange binding) and broadcasts to rooms through the Management API.

**Connection lifecycle**:

- `$connect` — JWT verified in-handler; connection registered in the `connections` table with `room` and a TTL.
- `$disconnect` — connection removed from the `connections` table.
- `$default` — client-driven actions routed by `action` in the body.
- `eventConsumer` — reads each event, resolves the target room(s), calls `PostToConnection` via the API Gateway Management API.

**Owns**:

- Its own `connections` DynamoDB table (ephemeral runtime state — lives with the service that uses it, not in the shared data tier).
- Its own WebSocket API + stage.
- Its own inbound fan-out queue (`emit`) + SNS subscription (no filter — consumes everything).

**Frontend WS URL**: the `foodo-realtime-<stage>-WebSocketUrl` export (`wss://…`).

---

### 7. Frontend

**Purpose**: Next.js 16 multi-role web application, deployed via SST Ion native OpenNext integration on CloudFront.

| Property | Value |
|----------|-------|
| Stack | `foodo-web` (SST) |
| Framework | Next.js 16, React 19 |
| Styling | Tailwind CSS v4, Shadcn UI (Radix-based) |
| State | TanStack Query, Zustand |
| Deploy | `sst deploy` (OpenNext → CloudFront) |

**Zero-Cost Reverse Proxy (Single Origin on CloudFront)**:

Next.js runs on `https://<id>.cloudfront.net/`. Browser calls relative `/api/*` (e.g. `/api/auth/login`) flow through the same CloudFront origin — a reverse proxy origin pointing at the deployed HTTP API URL. No custom domain needed, no CORS issues, and cookies are 100% same-origin first-party.

- `/api/*` requests → `ApiGatewayBackend` origin (the deployed `foodo-core-api` HTTP API URL), caching disabled, all viewer methods allowed.
- Everything else → the Next.js origin.

The SST config reads the live endpoints from CloudFormation exports at deploy time (`foodo-core-api-<stage>-HttpApiUrl`, `foodo-realtime-<stage>-WebSocketUrl`), falling back to stage defaults.

**Routes**:

| Route | Role | Description |
|-------|------|-------------|
| `/` | Customer | Restaurant discovery homepage |
| `/login` | All | User login |
| `/register` | All | User registration with role selection |
| `/seller` | Seller | Restaurant owner dashboard |
| `/rider` | Rider | Delivery rider mobile interface |
| `/admin` | Admin | Platform admin control panel |

---

## 🔄 Service Communication

```
                        ┌──────────────────────────┐
   Browser              │   CloudFront (single      │
   ─────────            │   origin, same-origin     │
   /api/* ──────────────┼──▶ API Gateway HTTP API    │
                        │   foodo-core-api          │
   ws://... ────────────┼──▶ API Gateway WS API      │
                        │   foodo-realtime           │
                        └──────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
        JWT authorizer       Service Lambdas       Realtime Lambdas
        (foodo-jwt)          (per stack)           (wsRouter,
              │                                    eventConsumer)
              │
              ▼
   ┌─────────────────────────────────────────────────────────┐
   │  foundation (foodo-infra)                                │
   │  DynamoDB tables  │  SNS events topic  │  SQS queues    │
   │  (8 tables)       │  (domain events)   │  payment + order│
   │                   │                    │  + DLQs        │
   └─────────────────────────────────────────────────────────┘
```

### Image uploads (signed direct upload, no utils-service hop)

1. Client fetches signed params from the owning service (`GET /api/menu-item/upload-signature`, `GET /api/restaurant/upload-signature`, or `GET /api/rider/upload-signature`).
2. Client POSTs the `File` straight to `https://api.cloudinary.com/v1_1/<cloud_name>/image/upload` with those params.
3. Client passes the resulting `secure_url` to the create/update endpoint.

Signatures are HMAC-SHA1 over sorted params (`@foodo/backend-common`) — purely local, <1ms, and the API secret never leaves the signing service. Multipart `file` uploads to the create/update endpoints still work as a legacy fallback (server-side upload via the same signer).

### Internal Communication

- Services authenticate inter-service calls via `x-internal-key` header matching `INTERNAL_SERVICE_KEY` (e.g. `/api/order/payment/claim/{orderId}`).
- SNS is the domain event bus; per-service filtered subscriptions route events to the right consumer.
- SQS work queues (payment, order) carry cross-service transport; each service owns its own fan-out queue + DLQ + SNS subscription.
- Realtime publishes to rooms through the API Gateway Management API; the `connections` table maps connectionId → room.

---

## 🎯 Event Topology

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

Each service **owns** its inbound queue, DLQ, and the SNS subscription (including the queue policy that lets SNS deliver). Work queues stay in the foundation stack because producers and consumers are different services.

### What runs where

| Service | Entrypoints (dist/) | Triggers |
|---|---|---|
| auth | `index` | HTTP `/api/auth/*` |
| restaurant | `http`, `paymentConsumer`, `riderEventsConsumer` | HTTP (5 routers) + payment work queue + SNS fan-out |
| rider | `http`, `orderReadyConsumer`, `riderEventsConsumer` | HTTP `/api/rider/*` + order work queue + SNS fan-out |
| admin | `index` | HTTP `/api/admin/*` |
| utils | `http`, `reconcile` | HTTP `/api/utils/*` + EventBridge `rate(1 hour)` |
| realtime | `wsRouter`, `eventConsumer` | WebSocket `$connect/$disconnect/$default` + SNS fan-out → Management API broadcasts |

---

## 📊 Database Schema Overview

All tables are in the foundation stack (`foodo-infra`), provisioned as single-table-per-entity with `pk`/`sk` key schema and the indexes each service query path needs. Services read/write their own tables through the AWS SDK v3 (`@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`) with per-service IAM statements.

### Users (`users` table)

```
pk        : USER#<userId>
sk        : USER#<userId>
email     : <email>            (GSI: email-index)
tokenHash : <hash>             (GSI: refresh-index, ttl attribute)
```

Auth-service owns this table. Refresh-token rows carry a per-item `ttl` — DynamoDB sweeps expired sessions automatically.

### Restaurants (`restaurants` table)

```
pk         : RESTAURANT#<restaurantId>
sk         : RESTAURANT#<restaurantId>
ownerId    : <userId>          (GSI: owner-index)
isVerified : 0|1               (GSI: verified-index)
```

Fields: name, description, image, ownerId, phone, isVerified, isOpen, autoLocation (lng/lat + formattedAddress).

Restaurant + admin services access this table.

### Riders (`riders` table)

```
pk         : RIDER#<riderId>
sk         : RIDER#<riderId>
userId     : <userId>          (GSI: user-index)
isVerified : 0|1               (GSI: verified-index)
```

Fields: userId, picture, phoneNumber, addharNumber, drivingLicenseNumber, isVerified, isAvailable, location (lng/lat), lastActive.

Rider + admin services access this table.

### Orders (`orders` table)

```
pk                          : ORDER#<orderId>
sk                          : ORDER#<orderId>
userId        (GSI)         : user-orders (pk=userId, sk=createdAt)
restaurantId (GSI)          : restaurant-orders (pk=restaurantId, sk=createdAt)
riderId       (GSI)         : rider-orders (pk=riderId, sk=createdAt)
status        (GSI)         : status-board (pk=status, sk=createdAt)
paymentStatus (GSI)         : payment-status (pk=paymentStatus,
                              sk=paymentIntentInitiatedAt)
```

Unpaid orders carry a per-item `ttl` (the 15-min payment window).

Fields: userId, restaurantId, restaurantName, riderId, riderName, riderPhone, distance, riderAmount, items (itemId/name/price/quantity), subtotal, deliveryFee, platformFee, totalAmount, addressId, deliveryAddress (formattedAddress/mobile/latitude/longitude), status, paymentMethod, paymentStatus, expiresAt.

Restaurant + rider + admin services access this table.

### Menu Items (`menu-items` table)

```
pk           : MENU_ITEM#<menuItemId>
sk           : MENU_ITEM#<menuItemId>
restaurantId (GSI: restaurant-index)
```

Fields: restaurantId, name, description, price, image, isAvailable.

Restaurant service accesses this table.

### Carts (`carts` table)

```
pk : CART#<userId>#<restaurantId>#<itemId>
sk : CART#<userId>#<restaurantId>#<itemId>
```

Fields: userId, restaurantId, itemId, quantity.

Restaurant service accesses this table.

### Addresses (`addresses` table)

```
pk : ADDRESS#<addressId>
sk : ADDRESS#<addressId>
```

Fields: userId, mobile, formatterAddress, location (lng/lat).

Restaurant service accesses this table.

### Webhook Dedupe (`webhook-dedupe` table)

```
pk    : <eventId>
ttl   : <expiry>   (TTL enabled)
```

Utils service accesses this table; used to dedupe payment webhooks.

---

## 📡 API Endpoints Reference

### Full API Map

| Service | Method | Endpoint | Auth | Notes |
|---------|--------|----------|------|-------|
| **Auth** | POST | `/api/auth/register` | Public | token issuance |
| **Auth** | POST | `/api/auth/login` | Public | token issuance |
| **Auth** | POST | `/api/auth/logout` | JWT | gateway + in-app |
| **Auth** | GET | `/api/auth/me` | JWT | gateway + in-app |
| **Auth** | GET | `/api/auth/socket-token` | JWT | gateway + in-app |
| **Auth** | `*` | `/api/auth/{proxy+}` | Public | remaining auth routes (refresh, etc.) |
| **Restaurant** | GET | `/api/restaurant/all` | Public | |
| **Restaurant** | GET | `/api/restaurant/nearby` | Public | |
| **Restaurant** | GET | `/api/restaurant/{id}` | Public | |
| **Restaurant** | GET | `/api/menu-item/all/{id}` | Public | |
| **Restaurant** | POST | `/api/order/payment/claim/{orderId}` | Public | x-internal-key |
| **Restaurant** | GET | `/api/restaurant/my` | JWT | explicit (not caught by `/restaurant/{id}`) |
| **Restaurant** | GET | `/api/restaurant/upload-signature` | JWT | explicit — signed direct upload |
| **Restaurant** | `*` | `/api/restaurant/{proxy+}` | JWT | |
| **Restaurant** | `*` | `/api/menu-item/{proxy+}` | JWT | |
| **Restaurant** | `*` | `/api/cart/{proxy+}` | JWT | |
| **Restaurant** | `*` | `/api/order/{proxy+}` | JWT | |
| **Restaurant** | `*` | `/api/address/{proxy+}` | JWT | |
| **Admin** | `*` | `/api/admin/{proxy+}` | JWT | entire surface |
| **Rider** | `*` | `/api/rider/{proxy+}` | JWT | entire surface |
| **Utils** | `*` | `/api/utils/{proxy+}` | Public | webhook HMAC + controller-validated |
| **Realtime** | WS | `$connect` | JWT (in-handler) | |
| **Realtime** | WS | `$disconnect` | — | |
| **Realtime** | WS | `$default` | — | client actions |

---

## 🚀 Installation & Local Development

### Prerequisites

Make sure the following are installed:

1. **Node.js** >= 20
2. **pnpm** >= 10 (`corepack enable` or `npm i -g pnpm`)

### Repository Layout (pnpm + Turborepo monorepo)

```
Foodo/
├── apps/
│   └── web/                 # Next.js web application (SST)
├── backend/
│   ├── auth-service/
│   ├── restaurant-service/
│   ├── rider-service/
│   ├── admin-service/
│   ├── realtime-service/
│   └── utils-service/
├── packages/
│   ├── types/               # @foodo/types (shared TS types, 0 deps)
│   └── backend-common/      # @foodo/backend-common (Node-only utils)
├── infra/                  # foodo-infra foundation stack (Serverless)
├── core/                   # foodo-core-api compute stack (Serverless)
├── package.json            # Root: turbo scripts + dev tools only
├── turbo.json              # Task pipeline (build, dev, lint, deploy, remove)
├── pnpm-workspace.yaml     # Workspace globs + version catalog
└── tsconfig.base.json      # Shared compiler options
```

### Quick Setup (Install Dependencies)

One command from the repository root installs everything via workspace symlinks:

```bash
pnpm install
```

### Running Locally (Old Shape — Express + MongoDB + RabbitMQ)

The local dev story from the previous architecture is still usable for iterating on service logic before deploying. Each service still has its own `dev` task that starts the Express server on its port; you still need MongoDB and RabbitMQ running locally.

```bash
# Start infrastructure
mongod
rabbitmq-server

# Start all services + web (turbo, shared terminal)
pnpm dev

# Or scope to a single workspace
pnpm --filter @foodo/auth-service dev
pnpm --filter web dev
```

Each service needs its own `.env` file. Create one in each service directory — see [Environment Variables Reference](#-environment-variables-reference) for the variables each service expects in local mode (these overlap with, but are not identical to, the deploy-time secrets).

Local image uploads still flow through the backend (the signed-direct-upload path is the deploy path); the `CLOUDINARY_URL` variable in restaurant/rider lets the signer work locally too.

**Note**: local dev starts the services as long-running Express processes. The canonical production path is `pnpm deploy:all`, which deploys the same services as Lambda functions behind API Gateway. The contract the frontend uses is the same either way — a single base URL with the same `/api/*` paths.

---

## ☁️ Deployment

### Deploy Commands

```bash
pnpm deploy:infra      # VPC, S3, Cognito, DynamoDB, SNS, SQS  (rarely changes)
pnpm deploy:core       # shared HTTP API + JWT authorizer      (rarely changes)
pnpm deploy:services   # ALL six service stacks (turbo, parallel)
pnpm deploy:frontend   # Next.js via SST Ion / OpenNext on CloudFront
```

Or everything at once:

```bash
pnpm deploy:all        # infra → core → services → seed → frontend
```

Deploy a single service (turbo chains its cached `build` first):

```bash
turbo run deploy --filter=@foodo/auth-service
turbo run deploy --filter=@foodo/restaurant-service -- --stage prod
```

### Secrets (deploy time, never committed)

Pass via environment (or per-service `.env.<stage>` files placed in each stack's directory): `JWT_SECRET`, `COOKIE_SECRET`, `INTERNAL_SERVICE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CLOUDINARY_URL` (restaurant + rider), `FRONTEND_URL`, `REFRESH_COOKIE_NAME`. Use the **same values across all stacks** in a stage (the JWT authorizer in core must verify the tokens auth-service mints).

```bash
STAGE=prod pnpm deploy:all
```

### IAM permissions boundary

All stacks honor an optional `IAM_PERMISSIONS_BOUNDARY_ARN` environment variable on the provider role. Leave it unset for dev; set it for prod accounts that enforce a permissions boundary.

### NAT gateways (opt-in)

Nothing runs in the VPC yet, so `params.default.natGateways: 0` (prod: 2, one per AZ). Flip it on in `infra/serverless.yml` when a workload moves into the private subnets — S3 + DynamoDB gateway endpoints are already wired to every route table.

### Logs (service-side)

```bash
pnpm logs:payment     # restaurant-service paymentConsumer --tail
pnpm logs:reconcile   # utils-service reconcile --tail
pnpm logs:realtime     # realtime-service eventConsumer --tail
```

---

## 🔄 Cutover from the Old Stacks

If you previously deployed the old `foodo-core` / `foodo-services` stacks:

1. Remove the old service stacks first (they own routes on the shared API): `cd infra/services && serverless remove` (paths per the old layout) — or simply `serverless remove` in the old directories before they were deleted in this refactor.
2. The old `foodo-core` data stack kept its tables; the new `foodo-infra` stack creates **fresh** tables under new names. Dev data (if any) must be migrated manually — there is no in-place upgrade.
3. Point the frontend at the new base URL (the `foodo-core-api-<stage>-HttpApiUrl` export) and the WS URL from the realtime stack.

---

## 🔐 Environment Variables Reference

### Deploy-time secrets (passed via env or `.env.<stage>`, same values across all stacks in a stage)

| Variable | Stacks | Description |
|----------|--------|-------------|
| `JWT_SECRET` | infra (Cognito future), all service stacks, core-api | JWT signing secret — must be identical everywhere in a stage |
| `COOKIE_SECRET` | auth, restaurant, admin, realtime, utils | Cookie session encryption key |
| `INTERNAL_SERVICE_KEY` | restaurant, rider, utils | Shared key for inter-service auth (`x-internal-key`) |
| `REFRESH_COOKIE_NAME` | auth | Name of the refresh-token cookie |
| `RAZORPAY_KEY_ID` | utils | Razorpay key id |
| `RAZORPAY_KEY_SECRET` | utils | Razorpay key secret |
| `RAZORPAY_WEBHOOK_SECRET` | utils | Razorpay webhook HMAC secret |
| `STRIPE_SECRET_KEY` | utils | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | utils | Stripe webhook HMAC secret |
| `CLOUDINARY_URL` | restaurant, rider | Cloudinary URL for signed direct uploads |
| `FRONTEND_URL` | utils | Frontend origin (for webhook redirects, etc.) |

### Stack-to-stack references (resolved via `${cf:...}` at deploy time)

| Variable | Where used | Source |
|----------|-----------|--------|
| `USERS_TABLE` | auth, admin | `${cf:foodo-infra-<stage>.UsersTable}` |
| `RESTAURANTS_TABLE` | restaurant, admin, rider | `${cf:foodo-infra-<stage>.RestaurantsTable}` |
| `RIDERS_TABLE` | rider, admin | `${cf:foodo-infra-<stage>.RidersTable}` |
| `ORDERS_TABLE` | restaurant, rider, admin, utils | `${cf:foodo-infra-<stage>.OrdersTable}` |
| `MENU_ITEMS_TABLE` | restaurant | `${cf:foodo-infra-<stage>.MenuItemsTable}` |
| `CARTS_TABLE` | restaurant | `${cf:foodo-infra-<stage>.CartsTable}` |
| `ADDRESSES_TABLE` | restaurant | `${cf:foodo-infra-<stage>.AddressesTable}` |
| `WEBHOOK_DEDUPE_TABLE` | utils | `${cf:foodo-infra-<stage>.WebhookDedupeTable}` |
| `EVENTS_TOPIC_ARN` | all services | `${cf:foodo-infra-<stage>.EventsTopicArn}` |
| `PAYMENT_QUEUE_URL` / `PAYMENT_QUEUE_ARN` | restaurant, utils | `${cf:foodo-infra-<stage>.PaymentQueueUrl/Arn}` |
| `ORDER_QUEUE_URL` / `ORDER_QUEUE_ARN` | rider | `${cf:foodo-infra-<stage>.OrderQueueUrl/Arn}` |
| `HttpApiId` / `AuthorizerId` | all service stacks | `${cf:foodo-core-api-<stage>.HttpApiId/AuthorizerId}` |
| `CONNECTIONS_TABLE_NAME` | realtime | own stack: `foodo-realtime-<stage>-connections` |
| `WEBSOCKET_API_ENDPOINT` | realtime | own stack: WebSocket API URL |
| `VpcId`, `PublicSubnetIds`, `PrivateSubnetIds` | (available for future VPC workloads) | `${cf:foodo-infra-<stage>.VpcId/PublicSubnetIds/PrivateSubnetIds}` |
| `CognitoUserPoolId`, `CognitoUserPoolClientId`, `CognitoIssuerUrl` | (available for future identity migration) | `${cf:foodo-infra-<stage>.CognitoUserPoolId/.../CognitoIssuerUrl}` |

### Local dev variables (per-service `.env`)

The local Express shape uses the same JWT/cookie/DB/queue variables but points them at local processes rather than CloudFormation exports:

| Variable | Services (local) | Description |
|----------|--------|-------------|
| `PORT` | all | Service port number |
| `MONGO_URI` | auth, restaurant, rider (local only) | MongoDB connection string (not used in deploy) |
| `RABBITMQ_URL` | restaurant, rider (local only) | RabbitMQ connection URL (not used in deploy) |
| `UTILS_SERVICE_URL` | restaurant, rider (local) | URL of the Utils microservice |
| `REALTIME_SERVICE_URL` | restaurant (local) | URL of the Realtime socket service |
| `RESTAURANT_SERVICE` | rider (local) | URL of the Restaurant microservice |

Local dev and deploy use different backing stores (MongoDB/RabbitMQ locally; DynamoDB/SNS/SQS in deploy). The in-service code path is the same; only the backing resource changes.

### Frontend env (SST resolves these at deploy time; local dev uses `.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_STAGE` | Deployed stage (`dev`, `prod`, etc.) |
| `NEXT_PUBLIC_API_URL` | Empty in deploy (same-origin relative paths via CloudFront reverse proxy) |
| `NEXT_PUBLIC_REALTIME_WS_URL` | Resolved from `foodo-realtime-<stage>-WebSocketUrl` export |

Local dev `.env.local` (old shape):

```
NEXT_PUBLIC_AUTH_SERVICE_URL=http://localhost:3000/api/auth
NEXT_PUBLIC_RESTAURANT_SERVICE_URL=http://localhost:3001
NEXT_PUBLIC_RIDER_SERVICE_URL=http://localhost:3003/rider
NEXT_PUBLIC_ADMIN_SERVICE_URL=http://localhost:3004/api
NEXT_PUBLIC_REALTIME_SERVICE_URL=http://localhost:3002
```

---

## 🛠 Tech Stack

### Backend (serverless)

| Technology | Purpose |
|------------|---------|
| **AWS Lambda** (ARM64, Node.js 20) | Compute for every service — individually packaged, per-stack |
| **API Gateway v2 HTTP API** | Single shared platform API — one base URL, CORS, route attachment by id |
| **API Gateway v2 WebSocket API** | Realtime — `$connect/$disconnect/$default` + Management API broadcasts |
| **API Gateway REQUEST authorizer** | Central `foodo-jwt` Lambda — verifies HS256 access token from session cookie or Bearer header |
| **DynamoDB** (PAY_PER_REQUEST, PITR on for prod) | 8 tables — single-table-per-entity, pk/sk, per-service IAM-scoped access |
| **SNS** | Domain event bus (`events` topic) — filtered fan-out to per-service subscriptions |
| **SQS** | Cross-service work queues (payment, order) + DLQs — replaces RabbitMQ transport |
| **EventBridge Scheduler** | `rate(1 hour)` trigger for utils reconciliation — replaces in-process `setInterval` |
| **S3** | Private uploads bucket (CORS, SSE, lifecycle) — direct browser PUT for signed uploads |
| **Cognito** | User pool + web client — provisioned now for the future issuer migration |
| **CloudFront** | Single-origin reverse proxy for the Next.js frontend — `/api/*` → API Gateway, everything else → Next.js |
| **SST (Ion)** | Frontend deploy — OpenNext native integration |
| **Serverless Framework v3** | Infrastructure-as-Code for all backend/core/infra stacks |
| **Turborepo** | Task pipeline — `build`, `dev`, `deploy`, `remove` with per-filter caching |
| **pnpm** | Package manager + workspaces + version catalog (`catalog:`) |
| **tsup** | Per-service bundler — individual packaging (`package.patterns`) |
| **AWS SDK v3** | `@aws-sdk/client-dynamodb`, `lib-dynamodb`, `client-sns`, `client-sqs`, `client-apigatewaymanagementapi`, `client-cloudformation` |
| **jsonwebtoken** | HS256 access token issuance + verification (auth-service mints; core authorizer verifies) |
| **cookie-session** | Session cookie management (browser stores the session; API Gateway passes the cookie to the authorizer) |
| **Razorpay / Stripe** | Payment gateway integration + HMAC webhook verification |
| **Cloudinary** | Image CDN — signed direct uploads (API secret stays server-side) |

### Frontend

| Technology | Purpose |
|------------|---------|
| **Next.js 16** | React meta-framework with App Router, deployed via SST Ion / OpenNext |
| **React 19** | UI library |
| **Tailwind CSS v4** | Utility-first styling |
| **Shadcn UI** | Accessible component primitives (Radix-based) |
| **TanStack Query** | Server state management & caching |
| **Zustand** | Client-side global UI state |
| **React Hook Form + Zod** | Form validation |
| **Framer Motion** | Animation library |
| **Lucide React + HugeIcons** | Icon libraries |
| **Leaflet + react-leaflet** | Map rendering (restaurant nearby, rider location) |

### Local dev (old shape, still usable)

| Technology | Purpose |
|------------|---------|
| **Node.js / Express** | HTTP server for each service (long-running process) |
| **MongoDB + Mongoose / native driver** | Local database (replaced by DynamoDB in deploy) |
| **RabbitMQ (amqplib)** | Local message queue (replaced by SQS/SNS in deploy) |
| **Socket.IO** | Local realtime server (replaced by WebSocket API in deploy) |
| **Vagrant / EC2** | Previous host shape for running the whole stack together — no longer the canonical path |

---

## 📁 Project Structure

```
backend/
├── auth-service/            # foodo-auth stack (@foodo/auth-service)
│   ├── src/
│   │   ├── config/          # DynamoDB connection
│   │   ├── controllers/     # Route handlers
│   │   ├── middlewares/     # Auth middleware (JWT)
│   │   ├── models/          # (DynamoDB access shapes)
│   │   └── routes/          # Auth routes
│   ├── serverless.yml       # Stack config
│   ├── package.json         # depends on @foodo/* via workspace:*
│   └── tsconfig.json        # extends ../../tsconfig.base.json
├── restaurant-service/      # foodo-restaurant stack
│   ├── serverless.yml       # HTTP + paymentConsumer + riderEventsConsumer
│   └── ...
├── rider-service/           # foodo-rider stack
│   ├── serverless.yml       # HTTP + orderReadyConsumer + riderEventsConsumer
│   └── ...
├── admin-service/           # foodo-admin stack
│   ├── serverless.yml       # HTTP /api/admin/*
│   └── ...
├── realtime-service/        # foodo-realtime stack
│   ├── serverless.yml       # wsRouter + eventConsumer + WS API + connections table
│   └── ...
└── utils-service/           # foodo-utils stack
    ├── serverless.yml       # HTTP + reconcile (EventBridge Scheduler)
    └── ...

apps/
└── web/                     # foodo-web (SST) — Next.js 16 / React 19
    ├── src/
    │   ├── app/             # App Router pages
    │   │   ├── (auth)/      # Login, Register
    │   │   ├── (customer)/  # Homepage
    │   │   ├── admin/       # Admin panel
    │   │   ├── rider/       # Rider dashboard
    │   │   └── seller/      # Seller dashboard
    │   ├── components/      # UI & shared components
    │   ├── features/        # Feature modules (auth, orders, restaurants)
    │   ├── hooks/           # Custom hooks
    │   ├── lib/             # API client, utilities
    │   ├── providers/       # TanStack Query, Toast
    │   ├── store/           # Zustand stores
    │   └── types/           # TypeScript definitions
    ├── sst.config.ts        # SST Ion / OpenNext + CloudFront reverse proxy
    ├── next.config.ts
    └── package.json

packages/
├── types/                   # @foodo/types — universal types (0 runtime deps)
└── backend-common/          # @foodo/backend-common — Node-only shared utils
    ├── src/
    │   ├── cloudinary/      # Signed direct upload signer (HMAC-SHA1, local)
    │   ├── dynamo/          # DynamoDB access shapes (legacy local naming)
    │   ├── files/           # dataUri, upload helpers
    │   ├── middlewares/     # tryCatch, multer, isAuth
    │   └── index.ts

infra/                      # foodo-infra foundation stack (Serverless)
├── serverless.yml          # VPC, S3, Cognito, DynamoDB (8 tables), SNS, SQS + DLQs
├── package.json
└── .env.example

core/                       # foodo-core-api compute stack (Serverless)
├── serverless.yml          # Shared HTTP API + JWT authorizer Lambda
├── src/
│   └── authorizer.ts       # HS256 JWT verify (session cookie or Bearer)
├── package.json
├── tsup.config.ts
└── tsconfig.json

scripts/
└── seed-demo-data.ts       # Demo data seed (run after deploy:all)
```

---

## 📜 License

This project is proprietary software. All rights reserved.

---

## 🤝 Contributing

1. Ensure the monorepo is installed (`pnpm install` from the root).
2. For local iteration on service logic, run `pnpm dev` (starts Express + MongoDB + RabbitMQ shape) — or scope to a single workspace with `pnpm --filter <service> dev`.
3. For the canonical production path, deploy through the three-tier pipeline: `pnpm deploy:infra && pnpm deploy:core && pnpm deploy:services && pnpm run seed && pnpm deploy:frontend` (or `pnpm deploy:all`).
4. Create a feature branch from `main`.
5. Make changes following the existing architecture patterns — per-service `serverless.yml` for new routes/functions, per-service IAM statements scoped to the tables/queues/topics it needs, and new domain events published to the shared `events` topic with per-service filtered subscriptions.
6. Verify builds with `pnpm build` (Turborepo caches and only rebuilds affected packages).
7. Submit a pull request with a clear description of changes.

### Deployment order reminder

- `infra` first — everything else reads its exports.
- `core` second — service stacks attach routes to its HTTP API and point protected routes at its authorizer.
- `services` third — they own routes on the shared API.
- `frontend` last — it reads the `HttpApiUrl` and `WebSocketUrl` exports at deploy time.
- Teardown in reverse: `frontend → services → core → infra`.
