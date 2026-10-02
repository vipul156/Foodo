# Architecture & Code Audit — Foodo

**Scope:** full repository at revision `4e76e2c4` (branch `serverless`)
**Auditor role:** Principal Engineer / System Architect / Security Auditor
**Method:** static inspection of every service, package, IaC stack and frontend module. Every finding below cites an exact file path and line. No finding is speculative — each was verified by reading the referenced code.

---

## Section 1: Executive Architecture Overview

### 1.1 Inferred architecture map

```
┌────────────────────────────────────────────────────────────────────────────┐
│ C1 — SYSTEM: Foodo (multi-role food delivery)                               │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ C2 — CONTAINERS                                                       │  │
│  │                                                                       │  │
│  │  [CDN] CloudFront (SST/OpenNext)                                      │  │
│  │     ├── behavior api/* → API Gateway origin  (TTL 0, cookies fwd)     │  │
│  │     ├── behavior /*     → Next.js SSR Lambda (1024 MB, arm64)         │  │
│  │     └── behavior wss    → WebSocket API (separate gateway)           │  │
│  │                                                                       │  │
│  │  [EDGE] API Gateway v2 HTTP  (foodo-core-api-<stage>)                 │  │
│  │     ├── JwtAuthorizer Lambda (128 MB)  — core/src/authorizer.ts       │  │
│  │     ├── routes → auth | restaurant | rider | admin | utils            │  │
│  │     └── NO CorsConfiguration (single-origin by design)                │  │
│  │                                                                       │  │
│  │  [EDGE] API Gateway v2 WS   (foodo-realtime-<stage>)                  │  │
│  │     ├── wsRouter      $connect/$disconnect/$default (256 MB)         │  │
│  │     └── eventConsumer SNS fanout → Management API (256 MB)            │  │
│  │                                                                       │  │
│  │  [APP] backend/*  — 6 Express-on-Lambda services (512 MB, arm64)       │  │
│  │     auth        ├ http                                             │  │
│  │     restaurant  ├ http  ├ paymentConsumer ├ riderEventsConsumer     │  │
│  │     rider       ├ http  ├ orderReadyConsumer  ├ riderEventsConsumer  │  │
│  │     admin       ├ http                                             │  │
│  │     utils       ├ http  ├ reconcile (EventBridge rate(1 hour))      │  │
│  │     realtime    ├ wsRouter  ├ eventConsumer                         │  │
│  │                                                                       │  │
│  │  [DATA] infra (foodo-infra-<stage>)                                   │  │
│  │     DynamoDB ×8  users restaurants riders orders menuItems            │  │
│  │                  carts addresses webhookDedupe                       │  │
│  │     SNS  foodo-events            SQS ×2  payment / order (+ DLQs)    │  │
│  │     S3 uploads (unused)  Cognito pool (unused)  VPC 10.0.0.0/16 (empty)│  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ C3 — SHARED PACKAGES                                                  │  │
│  │  @foodo/types           — zero-dep: UserRole, OrderStatus, AccessClaims│  │
│  │  @foodo/backend-common  — dynamo repos │ aws (SNS/SQS/geo/cache)      │  │
│  │                            │ middlewares │ cloudinary │ files        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  [EXT] Razorpay · Stripe · Cloudinary · OpenStreetMap Nominatim (client)    │
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Health scores

| Dimension | Score | Rationale |
|---|:--:|---|
| **Modularity** | **8 / 10** | Clean service boundaries, one aggregate per package file, explicit subpath exports to keep `@aws-sdk` out of the realtime bundle, `@foodo/types` genuinely shared by client and server. Loses a point for the god-object `order.ts` (≈600 lines, 9 handlers) and for `tryCatch` throwing away HTTP status. |
| **Scalability** | **4 / 10** | Everything is horizontally scalable and stateless — good. But `listRestaurantsNear` / `listAvailableRidersNear` issue `Query` calls with **no `Limit`** against a hot partition; `admin-service` runs an unbounded `Scan` on orders; and `listAllRestaurants`/`listAllRiders` are unbounded `ScanCommand`s. The geo matcher runs on *every* `ready_for_rider`. |
| **Reliability** | **6 / 10** | The saga is genuinely well designed — compensation events, conditional releases, fail-open webhook dedupe, DLQs, hourly reconciliation. Undermined by: an unbounded geo read on the critical delivery path, no tracing, no tests, and the `_id` contract break that breaks the dashboards the realtime layer exists to update. |
| **Security** | **4 / 10** | Good foundations: gateway-level JWT verification, opaque revocable refresh tokens with reuse detection, HMAC webhooks over raw bytes, `httpOnly`/`secure`/`SameSite`/`path` scoping, timing-safe signature comparison. Bad execution: **zero server-side input validation**, an **unauthorized `order:track` socket join**, a **7-day JWT** that defeats the 15-minute TTL, and no edge rate limiting. |
| **Code Cleanliness** | **6 / 10** | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` is genuinely excellent and rare. Comments are unusually high quality and honest. Offset by: dead code (`void listReadyOrders`), duplicated `distance.ts`, GSI doc comments that contradict `infra/serverless.yml`, `any` casts at several boundaries, `ReactQueryDevtools` shipped to production, and a `README.md` two architectures out of date. |

**Aggregate: 5.6 / 10** — an unusually thoughtful codebase undermined by a handful of unverified integration defects.

### 1.3 Top 3 critical risks under 10× traffic

**RISK 1 — Unbounded geo reads collapse the delivery path.**
`listAvailableRidersNear` runs on every `ready_for_rider` event with no `Limit` and a
`FilterExpression` on non-key attributes:

```
Query → verified-index (KeyCondition: isVerified = true)
Filter: isAvailable = true AND lat BETWEEN … AND lon BETWEEN …
```

A `FilterExpression` is applied **after** the read. With no sort key on `verified-index`,
DynamoDB must read **every** `isVerified=true` rider row before discarding the ones outside
the box. At 10 riders today that is free. At 10,000 riders, one `ready_for_rider` reads the
entire rider population inside a 30 s Lambda — and riders are *already* the hottest write path.

**RISK 2 — The admin dashboard performs a full table Scan on the only unbounded table.**
`getPlatformStats` runs `new ScanCommand({ TableName: TABLE.orders() })` on every dashboard
load and rolls up all revenue in Lambda. Scans consume read capacity proportional to table
size, not result size. This is the single item that will take the platform down under load,
and the source code already flags it.

**RISK 3 — There is no automated test suite protecting the money and rider paths.**
`detected_test_files: 0`. The hardest logic in the system — payment-claim idempotency,
the single-winner rider assignment, refresh-token reuse detection, refund-vs-capture
reconciliation — is entirely unverified. Any refactor (including the fixes in this audit)
can silently break it, and the only detector is production.

---

## Section 2: Comprehensive Flaw Matrix

| ID | Category | Severity | Component / File Path | Core Flaw Summary |
|---|---|:--:|---|---|
| F-01 | Contract / Runtime | **Critical** | `apps/web/src/types/index.ts` vs `packages/backend-common/src/dynamo/*.ts` | Frontend reads `entity._id`; backend returns `entity.id`. Only users are mapped. `order._id.slice(-8)` throws `TypeError`. |
| F-02 | Security / Runtime | **Critical** | `apps/web/src/lib/cloudinary-upload.ts:36-42` | Client drops `tags` + `transformation` from the signed parameter set → Cloudinary signature mismatch → all direct uploads fail. |
| F-03 | Security | **Critical** | all `backend/*/src/controllers/*.ts` | Zero server-side input validation. No zod/joi anywhere outside `apps/web`. Unvalidated `req.body` reaches repositories. |
| F-04 | Scalability | **Critical** | `packages/backend-common/src/dynamo/Rider.ts:110-146` | `listAvailableRidersNear` — unbounded `Query` + post-read `FilterExpression`. Runs on every `ready_for_rider`. |
| F-05 | Scalability | **Critical** | `backend/admin-service/src/controllers/admin.ts:~200` | `ScanCommand` over the entire orders table per dashboard load. |
| F-06 | Scalability | **High** | `packages/backend-common/src/dynamo/Restaurant.ts:125-152` | `listRestaurantsNear` — same unbounded geo-query anti-pattern; hit by every `/nearby` and every rider matcher. |
| F-07 | Security | **High** | `backend/realtime-service/src/config/websocket.ts:~100` | `order:track` joins any `order:{id}` room with no ownership check → live rider GPS leak. |
| F-08 | Security | **High** | `backend/restaurant-service/src/controllers/restaurant.ts:~95` | `getMyRestaurant` mints a **7-day** JWT — 672× the access TTL; defeats the minimal-claims design. |
| F-09 | Correctness | **High** | `packages/backend-common/src/dynamo/Rider.ts:~200` | `createRider` "uniqueness guard" queries `userId` **twice**; phone/aadhaar uniqueness claimed in the comment does not exist. |
| F-10 | Concurrency | **High** | `packages/backend-common/src/dynamo/Restaurant.ts:~215` | `updateRestaurantByOwner` is read-then-write with no `ConditionExpression` → lost updates. |
| F-11 | Concurrency | **High** | `Restaurant.ts:createRestaurant`, `Rider.ts:createRider` | `PutCommand` with no `ConditionExpression`; uniqueness enforced only by a controller pre-check → TOCTOU race. |
| F-12 | Reliability | **High** | `infra/serverless.yml` (no `CorsConfiguration`, no throttling) | No API Gateway usage plans. All rate limiting is per warm Lambda container; cold start resets every counter. |
| F-13 | Reliability | **High** | repo-wide | Zero tests. No CI gate. |
| F-14 | Reliability | **High** | `backend/restaurant-service/src/controllers/order.ts` (all `throw new Error`) | `tryCatch` maps every throw to **500**; `throw new Error("Unauthorized")` is not a 401, so the frontend's refresh-and-retry never fires. |
| F-36 | Security | **High** | `packages/backend-common/src/middlewares/isAuth.ts` | `isSeller` / `isAdmin` **fail open** when `req.user` is unset (falsy guard). Only `isRider` is fail-closed. |
| F-15 | Configuration | **High** | `backend/{restaurant,rider}-service/serverless.yml` | Declares `CLOUDINARY_URL`; signer reads `CLOUDINARY_CLOUD_NAME/_API_KEY/_API_SECRET` → 500 on every `/upload-signature`. |
| F-16 | Correctness | **Medium** | `packages/backend-common/src/dynamo/Order.ts:listOrdersBy*` | `FilterExpression: paymentStatus = paid` is post-read, but `Limit` counts pre-filter rows → pages can come back short. |
| F-17 | Scalability | **Medium** | `backend/rider-service/src/controller/rider.ts:~330` | `listReadyOrders(200)` then in-memory filter → a nearby order beyond the cap is invisible. |
| F-18 | Correctness | **Medium** | `backend/realtime-service/src/config/websocket.ts:~35` | `restaurant:{id}` room join keys off a claim the minimal JWT does not carry → room is dead; every publisher dual-emits as a workaround. |
| F-19 | Observability | **Medium** | all services | Unstructured `console.*`. No correlation ID propagated from the API Gateway access log into Lambda logs. |
| F-20 | Observability | **Medium** | all services | No standardized error envelope — five different response shapes across six services. |
| F-21 | Code Quality | **Medium** | `apps/web/src/providers/query-provider.tsx:31` | `<ReactQueryDevtools />` rendered unconditionally — shipped to the production client bundle. |
| F-22 | Correctness | **Medium** | `apps/web/src/lib/socket-events.ts:49,59` | `RiderAssignedPayload.order._id` — the server sends a raw `DynamoOrder` with `id`. Type contract is fiction. |
| F-23 | Correctness | **Medium** | `backend/auth-service/src/seed/demo-users.ts` | Weak demo passwords (`customer123`) committed in source; seeder is role-gated on nothing. |
| F-24 | Security | **Medium** | `backend/auth-service/src/controllers/auth.ts:~65` | No server-side password policy (frontend says 6, Cognito says 8). |
| F-25 | Concurrency | **Medium** | `packages/backend-common/src/aws/messaging.ts:makeFanoutPublisher` | Fire-and-forget publish swallows all errors; a lost `order:new` leaves the restaurant board stale with no recovery path. |
| F-26 | Scalability | **Medium** | `apps/web/src/app/sst.config.ts:cdn` | Reconnect backoff `500ms × 2^n` with no jitter → thundering herd on realtime cold start. |
| F-27 | Correctness | **Medium** | `infra/serverless.yml` vs `Restaurant.ts:18-21`, `Rider.ts:15-19` | GSI doc comments claim sort keys (`SK=name`, `SK=createdAt`) that do not exist in IaC. |
| F-28 | Code Quality | **Medium** | `backend/restaurant-service/src/lib/distance.ts` | Byte-identical duplicate of `packages/backend-common/src/aws/geo.ts`. |
| F-29 | Code Quality | **Low** | `backend/admin-service/src/controllers/admin.ts:~230` | `void listReadyOrders;` — dead import suppressed to silence lint. |
| F-30 | Code Quality | **Low** | `README.md`, `infra/README.md` | Root README documents MongoDB/RabbitMQ/Socket.IO — two architectures stale. |
| F-31 | Code Quality | **Low** | `packages/backend-common/src/cloudinary.ts` + `cloudinary/upload.ts` | Two files named `cloudinary*`; the second is a one-line re-export. |
| F-32 | Cost / Ops | **Low** | `infra/serverless.yml` | VPC + S3 bucket + Cognito pool provisioned and exported but entirely unused. |
| F-33 | Cost / Ops | **Low** | `packages/backend-common/src/dynamo/Restaurant.ts:listVerifiedRestaurants` | No `Limit` on the public catalog query — returns every verified restaurant. |
| F-34 | Cost / Ops | **Low** | `backend/*/tsup.config.ts` | `sourcemap: true` in production bundles; source recoverable from the deployed artifact. |
| F-35 | Correctness | **Low** | `apps/web/src/app/layout.tsx:60-72` | `dangerouslySetInnerHTML` theme script + double `suppressHydrationWarning`; no CSP. |

---

## Section 3: Deep-Dive Findings & Concrete Remediations

### 3.1 — [F-01] `id` vs `_id`: a silent, platform-wide contract break

**Component:** every backend entity except `User`, vs. every frontend consumer.
**Files:**
- `apps/web/src/types/index.ts` — 11 interfaces declare `_id: string`
- `apps/web/src/app/(customer)/orders/page.tsx:157, 208`
- `apps/web/src/app/(customer)/orders/[id]/page.tsx:120, 148, 299`
- `apps/web/src/app/seller/orders/page.tsx:127, 209, 236`
- `apps/web/src/app/rider/page.tsx:211-215`, `apps/web/src/app/rider/history/page.tsx:149-156`
- `packages/backend-common/src/dynamo/Order.ts`, `Restaurant.ts`, `Rider.ts`
- `backend/restaurant-service/src/dynamo/cart.ts` (Cart, MenuItem, Address)
- vs. `backend/auth-service/src/controllers/auth.ts:63` — the **only** place that maps

#### Impact & why it fails

The Mongo→DynamoDB migration renamed every primary key from `_id` to `id`. Only
`auth-service` was updated to preserve the old contract:

```ts
// backend/auth-service/src/controllers/auth.ts:59-69  — the ONLY mapping in the codebase
function publicUser(user: { id: string; name: string; … }) {
  return {
    _id: user.id, // web app contract keeps the Mongo-style `_id` key
    name: user.name, email: user.email, role: user.role, image: user.image,
  };
}
```

Everything else returns the raw DynamoDB item. I verified there is **no** `id → _id`
mapping anywhere else in the frontend:

```
$ grep -rn "_id:" apps/web/src --include=*.ts --include=*.tsx   → only type declarations + razorpay fields
$ grep -rn "interceptors" apps/web/src                          → (none)
$ grep -rn "id → _id" in features/orders/api/index.ts           → (none)
```

TypeScript does not catch it because `IOrder._id: string` is a *declaration*, and the
runtime value is `undefined`. Failure mode is therefore a **hard runtime crash**, not a
type error:

```tsx
// apps/web/src/app/(customer)/orders/page.tsx:208
Order #{order._id.slice(-8).toUpperCase()}
```

With `order._id === undefined` this throws
`TypeError: Cannot read properties of undefined (reading 'slice')` during render — which
React cannot recover from without an error boundary. There is an
`app/_global-error/page.tsx`, so the user sees the error page.

Every affected surface:

| Surface | Expression | Result |
|---|---|---|
| Customer order list | `key={order._id}`, `order._id.slice(-8)` | **render crash** |
| Order detail | `orderId={order._id}` to the tracking map | map subscribes to `order:undefined` |
| Seller order board | `order._id.slice(-6)` | **render crash** |
| Rider dashboard | `onAccept={() => handleAcceptOrder(order._id)}` | `POST /api/rider/accept/undefined` |
| Rider history | `expandedId === order._id` | rows never expand |
| Cart sheet | `getItemId()` reads `itemId._id` off a **populated** object | returns `undefined` |

The cart case is the most revealing — someone already hit this and patched it *locally*:

```ts
// apps/web/src/features/cart/components/cart-sheet.tsx:21-23
/** Extract the string _id from a populated or unpopulated itemId field */
function getItemId(itemId: string | { _id: string }): string {
  return typeof itemId === "object" ? itemId._id : itemId;
}
```

`GET /api/cart/all` returns `itemId` as the **populated menu item object**
(`cart.ts:60-66`), so the object branch is taken and `.\_id` is `undefined`. The string
branch — the one that would work — is dead code.

#### Current vulnerable code

```ts
// apps/web/src/types/index.ts:169  — declares a field the server never sends
export interface IOrder {
  _id: string;          // ← undefined at runtime
  userId: string;
  restaurantId: string;
  …
}

// packages/backend-common/src/dynamo/Order.ts — returns `id`, never `_id`
export async function listOrdersByUser(userId: string, limit = 50): Promise<DynamoOrder[]> {
  const out = await docClient().send(new QueryCommand({ /* … */ }));
  return (out.Items as DynamoOrder[]) ?? [];   // DynamoOrder.id, no _id
}
```

#### Target implementation

Pick **one** direction and enforce it with types. Recommendation: **restore the `_id` wire
contract at the repository boundary**, because it changes zero frontend lines.

```ts
// packages/backend-common/src/dynamo/serialize.ts  — NEW
/**
 * Wire-contract mapper. The Mongo→DynamoDB migration renamed `id` → `_id` on the
 * wire; the frontend's IOrder/IRestaurant/IMenuItem/ICartItem/IAddress/IRider
 * contracts were never updated. This restores `_id` in exactly ONE place so
 * every consumer is fixed simultaneously.
 *
 * MUST be applied to every entity returned over HTTP or the socket. Internal
 * code keeps using `.id`.
 */
export type WithWireId<T extends { id: string }> = Omit<T, "id"> & { _id: string };

export const toWire = <T extends { id: string }>(item: T): WithWireId<T> => ({
  ...item,
  _id: item.id,
});

export const toWireAll = <T extends { id: string }>(items: T[]): WithWireId<T>[] =>
  items.map(toWire);
```

Apply at every egress — order controller:

```ts
// backend/restaurant-service/src/controllers/order.ts
import { toWire, toWireAll } from "@foodo/backend-common/dynamo";

export const getMyOrders = tryCatch(async (req: AuthRequest, res) => {
  const orders = await listOrdersByUser(String(user._id));
  return res.status(200).json({
    success: true,
    count: orders.length,
    orders: toWireAll(orders),          // ← was: orders
  });
});

export const fetchSingleOrder = tryCatch(async (req: AuthRequest, res) => {
  const order = await getOrderById(orderId);
  if (order.userId !== String(user._id)) throw new UnauthorizedError();

  const menuById = await fetchMenuItemsForCart(order.items.map((i) => i.itemId));
  const orderObj = toWire(order);
  orderObj.items = order.items.map((item) => ({
    …item,
    image: menuById.get(item.itemId)?.image ?? null,
  }));

  return res.status(200).json({ success: true, order: orderObj });
});
```

And on the socket path, so `RiderAssignedPayload` becomes truthful:

```ts
// backend/restaurant-service/src/config/consumers.ts
async function emitAssignedRealtime(order: DynamoOrder, riderUserId?: string) {
  const wire = toWire(order);           // ← single source of truth
  await Promise.all([
    publishRealtimeEvent("order:rider_assigned", `restaurant:${order.restaurantId}`, { order: wire }),
    publishRealtimeEvent("order:rider_assigned", `user:${order.userId}`,           { order: wire }),
  ]);
  …
}
```

Then add a **compile-time guard** so this can never regress silently. Replace the hand-written
frontend interfaces with derived types:

```ts
// apps/web/src/types/index.ts
import type { DynamoOrder, DynamoRestaurant, DynamoRider } from "@foodo/backend-common/dynamo";
import type { DynamoCartRow, DynamoMenuItem, DynamoAddress } from "./wire-types";

/** Wire type = internal type with `_id` restored. */
export type Wire<T extends { id: string }> = Omit<T, "id"> & { _id: string; id?: string };

export type IOrder       = Wire<DynamoOrder>       & { items: Array<{ image?: string | null }> };
export type IRestaurant  = Wire<DynamoRestaurant>;
export type IRider       = Wire<DynamoRider>;
export type IMenuItem    = Wire<DynamoMenuItem>;
export type ICartItem    = Wire<DynamoCartRow>      & { itemId: IMenuItem; restaurantId: { _id: string } };
export type IAddress     = Wire<DynamoAddress>;
```

Now `order._id` is `string` (typed) **and** present (runtime), and if the backend ever stops
calling `toWire`, the unit tests below fail loudly instead of crashing a user's browser.

#### Trade-offs & migration path

**Zero-downtime, single deploy.** This is a pure backend change:
1. Deploy `toWire` + apply at all egress points.
2. Frontend unchanged — it already expects `_id`.
3. Idempotent and backward-compatible: if any *old* client is still running, it was already
   reading `_id` and getting `undefined`, so nothing regresses.

**Alternative considered and rejected:** rewriting the frontend to use `.id`. That is ~60
edit sites across 11 interfaces, touches every page, and changes `key=` props and route
params — far higher risk for zero user benefit.

**Add a regression test immediately:**

```ts
// backend/restaurant-service/__tests__/order.contract.test.ts
it("every order endpoint exposes _id for the web contract", async () => {
  const { body } = await agent.get("/api/order/my").set(authCookie);
  expect(body.orders.length).toBeGreaterThan(0);
  for (const o of body.orders) {
    expect(typeof o._id).toBe("string");   // fails today
    expect(o._id).toBe(o.id);
  }
});
```

---

### 3.2 — [F-02] Cloudinary direct upload: the client drops half the signed parameter set

**Component:** image upload for restaurants, menu items, rider KYC.
**Files:**
- `apps/web/src/lib/cloudinary-upload.ts:36-42`
- `packages/backend-common/src/cloudinary.ts` (signing)
- `backend/restaurant-service/src/controllers/upload.ts`

#### Impact & why it fails

Cloudinary's signature is computed over **exactly** the parameters that will be submitted.
The server signs **four**; the client sends **two**.

```ts
// packages/backend-common/src/cloudinary.ts — signs 4 params
const params: SignableParams = {
  timestamp: String(timestamp),
  folder: options.folder,
};
if (options.tags)          params.tags          = options.tags.join(",");   // ← SIGNED
if (options.transformation) params.transformation = options.transformation; // ← SIGNED

const signature = apiSignRequest(params, apiSecret);
// → SHA1("folder=foodo/menu-items&tags=foodo,menu-item&timestamp=…&transformation=w_1200,…&SECRET")

return { signature, timestamp, apiKey, cloudName, folder, tags, transformation };
//                            ↑ secret is correctly never returned
```

```ts
// apps/web/src/lib/cloudinary-upload.ts:36-42 — submits only 2 of them
const form = new FormData();
form.append("file", file);
form.append("api_key", params.apiKey);
form.append("timestamp", String(params.timestamp));
form.append("folder", params.folder);
form.append("signature", params.signature);
// ✗ params.tags never appended
// ✗ params.transformation never appended
```

Cloudinary recomputes `SHA1("folder=…&timestamp=…&SECRET")` from what it *received*. That
does not match. Result: **HTTP 400 `Error: Invalid Signature`** for every menu item,
restaurant cover, and rider KYC photo.

Compounding it — the client type declares only 5 fields, so the extra fields are dropped
even at compile time:

```ts
// apps/web/src/lib/cloudinary-upload.ts:12-18
export interface CloudinaryUploadParams {
  signature: string; timestamp: number; apiKey: string; cloudName: string; folder: string;
  // ✗ tags and transformation are returned by the server but absent here
}
```

And a second, independent break on the same feature: the stacks inject the **wrong variable
names** (F-15).

```yaml
# backend/restaurant-service/serverless.yml:49
CLOUDINARY_URL: ${env:CLOUDINARY_URL, ''}        # never read by anything
```

```ts
// packages/backend-common/src/cloudinary.ts — resolveCredentials()
const cloudName   = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey      = process.env.CLOUDINARY_API_KEY;
const apiSecret   = process.env.CLOUDINARY_API_SECRET;
if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary credentials missing: …");
```

So image upload is broken **twice over**: `/upload-signature` returns 500 unless the three
separate variables are set, *and* the upload would 400 even then.

#### Current vulnerable code

Combined, as shipped:

```ts
// SERVER — signs params the client will not send
export const getMenuItemImageSignature = tryCatch(async (_req, res) =>
  res.json(createCloudinaryUploadSignature({
    folder: "foodo/menu-items",
    tags: ["foodo", "menu-item"],
    transformation: "w_1200,h_1200,c_limit,q_auto",
  })));

// CLIENT — sends only the unsigned-of subset
form.append("file", file);
form.append("api_key", params.apiKey);
form.append("timestamp", String(params.timestamp));
form.append("folder", params.folder);
form.append("signature", params.signature);
```

#### Target implementation

**Step 1 — replay every signed parameter, driven by the server's own key list.** This makes
the two sides structurally incapable of drifting again:

```ts
// packages/backend-common/src/cloudinary.ts
export interface CloudinaryUploadSignature {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  /** Every parameter that was signed. The client MUST replay these verbatim. */
  signedParams: Record<string, string>;
  /** Echoed for convenience/debugging; not part of the upload contract. */
  folder: string;
  tags?: string[];
  transformation?: string;
}

export function createCloudinaryUploadSignature(
  options: CloudinarySignatureOptions,
): CloudinaryUploadSignature {
  const { cloudName, apiKey, apiSecret } = resolveCredentials();
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

  const params: SignableParams = { timestamp: String(timestamp), folder: options.folder };
  if (options.publicId !== undefined)       params.public_id   = options.publicId;
  if (options.tags?.length)                  params.tags        = options.tags.join(",");
  if (options.transformation)               params.transformation = options.transformation;
  for (const [k, v] of Object.entries(options.extraParams ?? {})) params[k] = String(v);

  return {
    signature: apiSignRequest(params, apiSecret),
    timestamp, apiKey, cloudName,
    signedParams: params,                    // ← the complete, authoritative set
    folder: options.folder,
    ...(options.tags?.length ? { tags: options.tags } : {}),
    ...(options.transformation ? { transformation: options.transformation } : {}),
  };
}
```

```ts
// apps/web/src/lib/cloudinary-upload.ts
export interface CloudinaryUploadParams {
  signature: string; timestamp: number; apiKey: string; cloudName: string;
  /** Authoritative set from the server — replay every entry. */
  signedParams: Record<string, string>;
  folder: string;
}

export async function uploadToCloudinary(
  file: File | Blob,
  params: CloudinaryUploadParams,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", params.apiKey);
  form.append("timestamp", String(params.timestamp));

  // Replay EVERY signed parameter. Order is irrelevant to Cloudinary
  // (it re-sorts by key), but completeness is mandatory.
  for (const [key, value] of Object.entries(params.signedParams)) {
    form.append(key, value);
  }
  form.append("signature", params.signature);

  const res = await fetch(CLOUDINARY_UPLOAD_URL(params.cloudName), { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Image upload failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const result = (await res.json()) as { secure_url?: string };
  if (!result.secure_url) throw new Error("Image upload returned no URL");
  return result.secure_url;
}
```

**Step 2 — fix the environment contract** in both stacks:

```yaml
# backend/restaurant-service/serverless.yml  (and rider-service)
    CLOUDINARY_CLOUD_NAME: ${env:CLOUDINARY_CLOUD_NAME, ''}
    CLOUDINARY_API_KEY:    ${env:CLOUDINARY_API_KEY, ''}
    CLOUDINARY_API_SECRET: ${env:CLOUDINARY_API_SECRET, ''}   # server-only, never NEXT_PUBLIC_*
```

**Step 3 — fail fast at boot rather than on first upload.** Today a missing secret only
surfaces when a seller tries to add a menu item:

```ts
// packages/backend-common/src/cloudinary.ts
const requireCloudinary = (): void => {
  const missing = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`[FATAL] Cloudinary not configured — missing: ${missing.join(", ")}`);
  }
};
```

#### Trade-offs & migration path

The `signedParams` change adds one response field and is **additive** — an older deployed
frontend ignores it and keeps its current (broken) behaviour, so there is no version-skew
hazard. Deploy backend first, then frontend.

Also note: with `transformation` now actually applied, images will be resized
(`w_1200,h_1200,c_limit,q_auto`) for the first time — expect a **one-time CDN re-upload** if
you want assets reprocessed, and confirm the bucket's eager transformations still match.

---

### 3.3 — [F-03] Zero server-side input validation across all six services

**Component:** every HTTP controller.
**Files:** `backend/*/src/controllers/*.ts` — 40+ handlers.
**Evidence:**

```
$ grep -rn 'from "zod"' backend/ packages/ core/ --include=*.ts
(no matches)
```

Zod exists **only** in the frontend (`apps/web/src/features/auth/schemas/index.ts`) and only
covers the login/register forms. Every other request body flows from `req.body` straight into
a repository.

#### Impact & why it fails

Client-side validation is a UX affordance, not a control. It is trivially bypassed with
`curl`. Concrete, currently-reachable consequences:

| Endpoint | Client sends | Server does | Consequence |
|---|---|---|---|
| `POST /api/order/new` | `{ paymentMethod: "free_money" }` | passes `if (!paymentMethod)` | order created with an unknown `paymentMethod`; `isCod` is `false`, so it gets a 15-min TTL and is never claimable — a permanently orphaned order |
| `POST /api/menu-item/new` | `{ name: "X", price: -500 }` | passes `if (!name \|\| !price)` — `-500` is truthy | **negative-priced menu item**; every future order's `subtotal` is wrong |
| `POST /api/menu-item/new` | `{ price: 1e308 }` | truthy | `subtotal` overflows to `Infinity`; `totalAmount` becomes `Infinity`, `riderAmount` `Infinity` — sent to the payment provider |
| `POST /api/address/new` | `{ latitude: "NaN" }` | `Number(longitude)` → `NaN` | `NaN` persisted into `location.coordinates`; every haversine against it returns `NaN`, so `deliveryDistanceKm` floors to `1` → `riderAmount` ₹17 forever |
| `POST /api/restaurant/new` | `latitude: 999` | only checks truthiness | corrupt restaurant coordinate; poisons the geo bounding box for everyone |
| `PUT /api/order/:id` | `status: "HACKED"` | `ACCEPTED_STATUSES.includes()` **does** guard | ✅ correct — the one place with an allowlist |
| `POST /api/address/new` | `formatterAddress: "<script>"` | stored raw | stored XSS if ever rendered unescaped |

The `price` case is the most serious: **negative and unbounded numbers reach the money
path**, and the server-side total is what the payment provider is asked to charge.

#### Current vulnerable code

```ts
// backend/restaurant-service/src/controllers/menuItem.ts
const { name, description, price } = req.body;      // ← untyped, unvalidated
if (!name || !price) {
  throw new Error("Name and price are required");   // 500, not 400; and `-500` passes
}
const menuItem = await createMenuItem({
  name, description, price, image: imageUrl, restaurantId: restaurant.id,
});
```

```ts
// backend/restaurant-service/src/controllers/address.ts
const { mobile, formatterAddress, latitude, longitude } = req.body;
if (latitude == null || longitude == null) throw new Error("Location coordinates are required");
location: { type: "Point", coordinates: [Number(longitude), Number(latitude)] }
//                             ↑ Number("abc") → NaN, written to the database
```

#### Target implementation

Adopt Zod on the server, shared from `@foodo/types` so schemas live next to the contracts
they enforce.

```ts
// packages/types/src/schemas.ts  — NEW
import { z } from "zod";

/** Money in whole rupees. Non-negative, bounded, integer-ish. */
export const MoneyRupees = z.coerce.number()
  .finite("Amount must be a finite number")
  .nonnegative("Amount cannot be negative")
  .max(10_000_000, "Amount is unrealistically large");

export const GeoPoint = z.object({
  latitude:  z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

export const PaymentMethodEnum = z.enum(["razorpay", "stripe", "cod"]);

export const CreateOrderBody = z.object({
  addressId:     z.string().min(1),
  paymentMethod: PaymentMethodEnum,
}).strict();                    // ✗ unknown keys rejected

export const CreateMenuItemBody = z.object({
  name:        z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  price:       MoneyRupees,
  category:    z.string().trim().max(60).optional(),
  imageUrl:    z.string().url().startsWith("https://").optional(),
}).strict();

export const CreateAddressBody = z.object({
  mobile:           z.coerce.number().int().min(1e8).max(1e10),
  formatterAddress: z.string().trim().min(5).max(400),
  latitude:         GeoPoint.shape.latitude,
  longitude:        GeoPoint.shape.longitude,
}).strict();

export const UpdateOrderStatusBody = z.object({
  status: z.enum(["accepted", "preparing", "ready_for_rider"]),
}).strict();

export const ToggleRiderBody = z.object({
  isAvailable: z.boolean(),
  latitude:  GeoPoint.shape.latitude,
  longitude: GeoPoint.shape.longitude,
}).strict();
```

Add the validation middleware, and **make it status-preserving** (which also fixes F-14):

```ts
// packages/backend-common/src/middlewares/validate.ts  — NEW
import type { RequestHandler } from "express";
import type { ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const validate = <T extends ZodTypeAny>(schema: T, source: "body" | "query" | "params" = "body"): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new HttpError(400, result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")));
    }
    (req as any).validated = result.data;   // controllers read the PARSED value, never raw
    next();
  };

// Unified error handler that fixes F-14 at the same time.
export const errorHandler: RequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error("[unhandled]", err);
  res.status(status).json({ error: { status, message: err.message ?? "Internal Server Error" } });
};
```

```ts
// backend/restaurant-service/src/routes/menu-item.ts
router.post("/new", isSeller, uploadFile, validate(CreateMenuItemBody), createMenuItemController);

// backend/restaurant-service/src/controllers/menuItem.ts
export const createMenuItemController = tryCatch(async (req: AuthRequest, res) => {
  const { name, description, price, imageUrl } = req.validated as CreateOrderBody; // typed + validated
  …
});

// backend/restaurant-service/src/index.ts — register once, after all routes
app.use(errorHandler);
```

This delivers four wins at once: real 400s instead of 500s (F-14), rejection of negative
money, `strict()` blocks unknown keys, and `req.validated` gives every controller a typed
payload instead of `any`.

#### Trade-offs & migration path

Adopt **per route, incrementally** — the middleware is a no-op on un-annotated routes, so
there is no big-bang cutover. Order of rollout: money paths first (`order/new`, `menu-item/new`),
then geo (`address/new`, `restaurant/new`, `rider/toggle`), then the rest.

`zod` must move into the catalog as a **runtime** dependency of `@foodo/types` (it is
currently only in `apps/web`), and `@foodo/types` is imported by the browser bundle — so either
split into `@foodo/types/schema` subpath (mirroring the existing `backend-common` subpath
pattern) or ship Zod as a shared dep. The subpath route is preferred; it keeps the client's
type-only bundle free of the validator runtime.

---

### 3.4 — [F-04] `listAvailableRidersNear`: unbounded read on the critical delivery path

**Component:** rider matching — invoked on **every** `ready_for_rider` event.
**Files:**
- `packages/backend-common/src/dynamo/Rider.ts:110-146`
- `backend/rider-service/src/config/consumers.ts` (`orderReadyHandler`)
- `infra/serverless.yml` (`riders` table, `verified-index`)

#### Impact & why it fails

This is the single most dangerous scalability defect. Here is the query in full:

```ts
export async function listAvailableRidersNear(
  lat: number, lon: number, radiusMeters = 10_000,
): Promise<DynamoRider[]> {
  const box = boundingBox(lat, lon, radiusMeters / 1000);

  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.riders(),
      IndexName: "verified-index",
      KeyConditionExpression: "isVerified = :v",
      FilterExpression:
        "isAvailable = :a AND lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon",
      ExpressionAttributeValues: { ":v": true, ":a": true, ":minLat": box.minLat, … },
      // ⚠ NO Limit.
    }),
  );

  const candidates = (out.Items as DynamoRider[]) ?? [];
  return candidates
    .map((r) => ({ rider: r, distance: distanceMeters([lon, lat], r.location.coordinates) }))
    .filter((x) => x.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .map((x) => x.rider);
}
```

Three compounding problems:

1. **`verified-index` has no sort key.** `infra/serverless.yml` defines it as
   `{ AttributeName: isVerified, KeyType: HASH }` only. Every verified rider shares one
   partition.
2. **`FilterExpression` is post-read.** DynamoDB reads matching index items, then discards
   non-matches. `isAvailable`, `lat` and `lon` are **not** in the key, so **none** of them
   reduce the read. The read volume is `|all verified riders|`, always.
3. **No `Limit`.** The query will page to exhaustion of the partition.

Cost is therefore `O(total riders)` per order-ready event, not `O(nearby riders)`.

Failure mode: as the rider population grows, `orderReadyConsumer` (30 s timeout, batch of 5)
starts timing out. A timeout means **no rider is ever notified** — the order sits at
`ready_for_rider` forever with nobody told. This is a silent business outage, not an error.

Worse, the caller then fans out one WebSocket broadcast per returned rider with no cap:

```ts
// backend/rider-service/src/config/consumers.ts
await Promise.all(
  riders.map((rider) =>
    publishRealtimeEvent("order:available", `user:${rider.userId}`, { orderId, restaurantId }),
  ),
);
```

#### Current vulnerable code

Reproduced above. The `infra` definition that makes it unbounded:

```yaml
      - IndexName: verified-index
        KeySchema:
          - { AttributeName: isVerified, KeyType: HASH }    # ⚠ no Range key
        Projection: { ProjectionType: ALL }
```

#### Target implementation

**Add a geo hash to the key.** The standard DynamoDB geo pattern: discretize lat/lon into a
low-cardinality geohash, make it the GSI partition key, and issue one `Query` per cell in
range. Read volume becomes `O(cells near you)` instead of `O(world)`.

```ts
// packages/backend-common/src/aws/geohash.ts  — NEW
/**
 * Minimal geohash (base-32, 5 chars ≈ 5 km cell). Sufficient for "riders within
 * 10 km of one restaurant" — we need a coarse locality index, not street-level
 * geocoding. Zero dependencies.
 */
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function geohash(lat: number, lon: number, precision = 5): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, hash = "", bits = 0, bit = 0, even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { bits = (bits << 1) | 1; lonMin = mid; } else { bits <<= 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { bits = (bits << 1) | 1; latMin = mid; } else { bits <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += B32[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

/** The 3×3 neighbourhood of cells around a point — covers the radius's bounding box. */
export function geohashNeighbours(lat: number, lon: number, precision = 5): string[] {
  const [minLat, maxLat] = [-90, 90];
  void minLat; void maxLat;
  // Neighbour enumeration: decode-adjacent is fiddly; instead widen the box and
  // re-hash its 4 corners + centre. For a 10 km radius a 5-char cell (~5 km)
  // needs a 5×5 sweep, which is still O(1) queries.
  const out = new Set<string>();
  const dLat = 0.09, dLon = 0.11; // ≈ 10 km at the equator, widened for cos(lat)
  for (let i = -2; i <= 2; i++)
    for (let j = -2; j <= 2; j++)
      out.add(geohash(lat + i * dLat * 0.5, lon + j * dLon * 0.5, precision));
  return [...out];
}
```

```ts
// packages/backend-common/src/dynamo/Rider.ts
/**
 * $near replacement backed by a geohash partition key.
 * Index: geo-index  PK=geohash  SK=isAvailable#updatedAt
 * Read volume is now O(cells in range), independent of total rider count.
 */
export async function listAvailableRidersNear(
  lat: number, lon: number, radiusMeters = 10_000,
): Promise<DynamoRider[]> {
  const cells = geohashNeighbours(lat, lon, 5);

  const results = await Promise.all(
    cells.map((cell) =>
      docClient().send(new QueryCommand({
        TableName: TABLE.riders(),
        IndexName: "geo-index",
        KeyConditionExpression: "geohash = :g",
        FilterExpression: "isVerified = :v AND isAvailable = :a",
        ExpressionAttributeValues: { ":g": cell, ":v": true, ":a": true },
        Limit: 50,                                  // ← hard bound per cell
      })),
    ),
  );

  const candidates = results.flatMap((r) => (r.Items as DynamoRider[]) ?? []);
  return candidates
    .map((r) => ({ rider: r, distance: distanceMeters([lon, lat], r.location.coordinates) }))
    .filter((x) => x.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 50)                                  // ← never notify more than 50
    .map((x) => x.rider);
}
```

Write side — keep `geohash` in sync wherever location changes:

```ts
// packages/backend-common/src/dynamo/Rider.ts
import { geohash } from "../aws/geohash.js";

export async function setRiderAvailability(
  userId: string, isAvailable: boolean, coordinates: [number, number],
): Promise<DynamonRider | null> {
  const rider = await getRiderByUserId(userId);
  if (!rider) return null;
  const [lon, lat] = coordinates;

  const out = await docClient().send(new UpdateCommand({
    TableName: TABLE.riders(),
    Key: { pk: rider.pk, sk: rider.sk },
    UpdateExpression:
      "SET isAvailable = :a, #loc = :loc, lat = :lat, lon = :lon, geohash = :g, lastActive = :now, updatedAt = :now",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeNames: { "#loc": "location" },
    ExpressionAttributeValues: {
      ":a": isAvailable,
      ":loc": { type: "Point", coordinates },
      ":lat": lat, ":lon": lon,
      ":g": geohash(lat, lon, 5),                  // ← denormalised geo key
      ":now": new Date().toISOString(),
    },
    ReturnValues: "ALL_NEW",
  }));
  return (out.Attributes as DynamoRider) ?? null;
}
```

Also cap the fan-out (F-25's sibling) so one busy restaurant cannot melt the consumer:

```ts
// backend/rider-service/src/config/consumers.ts
const MAX_NOTIFIED_RIDERS = 50;
const riders = await listAvailableRidersNear(lat, lon, 10_000);
await Promise.all(
  riders.slice(0, MAX_NOTIFIED_RIDERS).map((r) =>
    publishRealtimeEvent("order:available", `user:${r.userId}`, { orderId, restaurantId }),
  ),
);
```

#### Trade-offs & migration path

Requires a new GSI, so it is **not** a drop-in. Zero-downtime sequence:

1. **Add the GSI** (`geo-index`, PK `geohash`, SK `isAvailable#updatedAt`, PAY_PER_REQUEST so
   it costs nothing while empty). Backfill `geohash` for existing riders with a one-off script
   — `UpdateItem` per rider, safe to run repeatedly.
2. **Dual-write** — add `geohash` to `setRiderAvailability` and `createRider` while the
   reader still uses `verified-index`.
3. **Flip the reader** once backfill reports zero missing attributes.
4. **Drop the old read path**, then drop `verified-index` if `listPendingRiders`/`listAllRiders`
   are re-pointed.

Interim mitigation while you schedule that: add `Limit: 200` and `Segment: false` to the
existing query so a bad day produces *partial* results rather than a timeout — an imperfect
rider board beats no notifications at all. Note that `Limit` is a *page* size, so this caps
each page but the caller still pages through; use `Select: "COUNT"`-free early termination or
accept the approximation during the transition.

---

### 3.5 — [F-05] `admin-service` runs a full-table `Scan` on the orders table

**Component:** `GET /api/admin/stats`.
**File:** `backend/admin-service/src/controllers/admin.ts` (~line 200).

#### Impact & why it fails

```ts
// The comment is admirably honest about this:
//   "Bounded growth: orders are the one collection that grows unboundedly,
//    so production should replace this scan with Streams-maintained counters"
const ordersOut = await docClient().send(
  new ScanCommand({ TableName: TABLE.orders() }),   // ⚠ entire table, no Limit
);
const orders = (ordersOut.Items as DynamoOrder[]) ?? [];
```

DynamoDB `Scan` consumes read capacity in **1 MB pages until the table is exhausted**, and
returns everything regardless of `Limit`. Cost is `O(table size)`; latency grows linearly;
and `Scan` returns items in an arbitrary (partition-hash) order, so it needs pagination to be
complete — but the code does **not** paginate, so it silently reads only the first 1 MB.

Three distinct failures in one line:
1. **Cost** — a dashboard refresh scans the whole table.
2. **Correctness** — without `ExclusiveStartKey` looping, anything past 1 MB is missing, so
   revenue totals are **wrong** and silently so.
3. **Latency** — grows without bound; will eventually exceed the 15 s Lambda timeout, giving a
   504 on the admin analytics page.

#### Current vulnerable code

```ts
export const getPlatformStats = tryCatchStatus(async (_req, res) => {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const ordersOut = await docClient().send(new ScanCommand({ TableName: TABLE.orders() }));
  const orders = (ordersOut.Items as DynamoOrder[]) ?? [];

  const paidValid = orders.filter((o) => o.paymentStatus === "paid" && o.status !== "cancelled");
  const totalRevenue = paidValid.reduce((sum, o) => sum + o.totalAmount, 0);
  …
});
```

#### Target implementation

**Materialised counters via DynamoDB Streams.** The order state transitions are few and
known — `markOrderPaid`, `cancelOrder`, `setOrderStatus`, `transitionRiderStatus` — which
makes a counter projection exact and cheap.

```ts
// packages/backend-common/src/dynamo/Counter.ts  — NEW
export interface CounterRow {
  pk: "COUNTER";                       // hot partition, tiny items
  sk: string;                          // "revenue#all" | "revenue#2026-10-02" | "orders#all" …
  value: number;
  updatedAt: string;
}

/**
 * Idempotent projection source. `apply` returns the DELTA implied by a single
 * order transition, or null when the transition contributes nothing (which is
 * how stream redelivery becomes a no-op).
 */
export interface OrderDelta {
  revenueDelta: number;                // whole rupees
  orderCountDelta: number;
  restaurantId?: string;
}
```

```ts
// packages/backend-common/src/dynamo/Counter.ts
const counterPk = "COUNTER";
const daySk = (iso: string) => `revenue#${iso.slice(0, 10)}`;

export async function applyOrderDelta(delta: OrderDelta, at: string): Promise<void> {
  const items = [
    { sk: "revenue#all",  v: delta.revenueDelta },
    { sk: "orders#all",   v: delta.orderCountDelta },
    { sk: daySk(at),      v: delta.revenueDelta },
  ].filter((x) => x.v !== 0);

  if (items.length === 0) return;

  await docClient().send(new TransactWriteCommand({
    TransactItems: items.map((x) => ({
      Update: {
        TableName: TABLE.counters(),
        Key: { pk: counterPk, sk: x.sk },
        UpdateExpression: "ADD #v :delta SET updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) OR attribute_not_exists(pk)", // upsert
        ExpressionAttributeNames: { "#v": "value" },
        ExpressionAttributeValues: { ":delta": x.v, ":now": new Date().toISOString() },
      },
    })),
  }));
}
```

Wire it to the existing single-writer functions, so deltas are computed **at the point of
truth** rather than re-derived from the stream's before/after images:

```ts
// packages/backend-common/src/dynamo/Order.ts
export async function markOrderPaid(orderId: string): Promise<DynamoOrder | null> {
  const out = await docClient().send(new UpdateCommand({
    /* … existing conditional update unchanged … */
  })).catch(() => null);

  const order = out?.Attributes as DynamoOrder | undefined;
  if (order) {
    // Only a real transition (null ⇒ already paid) contributes.
    await applyOrderDelta(
      { revenueDelta: order.totalAmount, orderCountDelta: 1, restaurantId: order.restaurantId },
      order.updatedAt,
    );
  }
  return order ?? null;
}
```

The stats endpoint then reads a handful of tiny counter items:

```ts
// backend/admin-service/src/controllers/admin.ts
export const getPlatformStats = tryCatchStatus(async (_req, res) => {
  const counters = await docClient().send(new BatchGetCommand({
    RequestItems: {
      [TABLE.counters()]: {
        Keys: [
          { pk: "COUNTER", sk: "revenue#all" },
          { pk: "COUNTER", sk: "orders#all" },
          { pk: "COUNTER", sk: `revenue#${monthStartIso.slice(0, 10)}` },
        ],
        ConsistentRead: true,
      },
    },
  }));

  // … same response shape, sourced from counters + bounded list queries for the
  //   status/role breakdowns. No orders Scan anywhere.
});
```

#### Trade-offs & migration path

Counters are eventually consistent by construction; the dashboard may lag by the duration of
one `applyOrderDelta` call (sub-second). For an analytics view that is entirely acceptable —
and strictly better than today's **silently wrong** numbers past 1 MB.

Migration:
1. Create `foodo-infra-<stage>-counters` (`pk`, `sk`).
2. Backfill with one full `Scan` (acceptable once, offline).
3. Ship `applyOrderDelta` calls in the transition functions (idempotent, safe to deploy alone).
4. Flip `getPlatformStats` to read counters.
5. Delete the `ScanCommand`.

If you need a stopgap before any of that, at minimum paginate the scan correctly so the
numbers are right, and gate the endpoint behind an explicit admin role plus CloudWatch
alarms on read capacity — but treat that as a bridge, not a fix.

---

### 3.6 — [F-07] `order:track` has no authorization check — live GPS leak

**Component:** realtime WebSocket router.
**File:** `backend/realtime-service/src/config/websocket.ts` (`handleDefault`, ~line 100).

#### Impact & why it fails

```ts
switch (message.action) {
  case "order:track":
    if (message.orderId) {
      await joinRoom(connectionId, `order:${message.orderId}`);   // ⚠ no ownership check
    }
    break;
```

Room membership **is** the subscription. Once a connection is in `order:{id}`, it receives
every `rider:location` broadcast for that order. The rider streams GPS every 5 seconds:

```ts
// apps/web/src/hooks/use-rider-location-stream.ts — MIN_PING_INTERVAL_MS = 5000
socket.emit("rider:location", { orderId, latitude, longitude });
```

So any authenticated user (a customer, a seller, or a rider) who knows or guesses an order
id can read **that delivery's live coordinates indefinitely**. Order ids are UUIDv4, so
guessing is not practical — but they are *not secret*: they appear in URLs
(`/orders/${order._id}`), in Razorpay/Stripe `receipt`/`metadata`, in order rows returned by
the admin API, and in browser history.

Mitigating factor: the HTTP endpoints that serve order *contents* do verify
`order.userId === user._id`, so this leaks coordinates, not PII or order details. That is the
difference between a High and a Critical, but it is still a privacy failure.

#### Current vulnerable code

```ts
const message = JSON.parse(event.body);

switch (message.action) {
  case "order:track":
    if (message.orderId) await joinRoom(connectionId, `order:${message.orderId}`);
    break;

  case "rider:location": {
    const { orderId, latitude, longitude } = message;
    if (orderId && typeof latitude === "number" && typeof longitude === "number") {
      await broadcastToRoom(endpoint, `order:${orderId}`, "rider:location", { … });
    }
    break;                                    // ⚠ also unauthenticated
  }
}
```

Note `rider:location` is also unvalidated: **any** connected client can inject fake GPS into
an order room, which the customer's live map renders as the real rider position.

#### Target implementation

Authorise at join time, and restrict the broadcast action to the assigned rider.

```ts
// backend/realtime-service/src/config/websocket.ts
import { getOrderById, getRiderByUserId } from "@foodo/backend-common/dynamo";

/** Resolve the connection's principal once, at $connect, and carry it forward. */
export interface SocketPrincipal { sub: string; role: string; }

const mayTrack = async (orderId: string, principal: SocketPrincipal): Promise<boolean> => {
  const order = await getOrderById(orderId);
  if (!order) return false;
  if (order.userId === principal.sub) return true;                       // customer

  const restaurant = await getRestaurantById(order.restaurantId);
  if (restaurant?.ownerId === principal.sub) return true;                // seller

  const rider = await getRiderByUserId(principal.sub);
  if (rider && order.riderId === rider.id) return true;                  // assigned rider

  return false;
};

export const handleDefault = async (event, context) => {
  const connectionId = event.requestContext.connectionId!;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  if (!event.body) return ok();

  let message: { action: string; [key: string]: any };
  try { message = JSON.parse(event.body); } catch { return fail(400, "Invalid JSON"); }

  const principal = await loadPrincipal(connectionId);   // cached at $connect

  switch (message.action) {
    case "order:track": {
      const { orderId } = message;
      if (!orderId || typeof orderId !== "string") return fail(400, "orderId required");
      if (!(await mayTrack(orderId, principal))) return fail(403, "Not authorized to track this order");
      await joinRoom(connectionId, `order:${orderId}`);
      break;
    }

    case "order:untrack":
      if (message.orderId) await leaveRoom(connectionId, `order:${message.orderId}`);
      break;

    case "rider:location": {
      const { orderId, latitude, longitude } = message;
      if (!orderId || typeof latitude !== "number" || typeof longitude !== "number")
        return fail(400, "orderId, latitude and longitude are required");
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
        return fail(400, "Coordinates out of range");

      // Only the ASSIGNED rider may inject into an order's location stream.
      const rider = await getRiderByUserId(principal.sub);
      const order = await getOrderById(orderId);
      if (!rider || !order || order.riderId !== rider.id)
        return fail(403, "Only the assigned rider may broadcast location");

      await broadcastToRoom(endpoint, `order:${orderId}`, "rider:location", {
        orderId, latitude, longitude, at: Date.now(),
      });
      break;
    }
  }
  return ok();
};
```

This requires granting the realtime service read access to the orders/restaurants/riders
tables:

```yaml
# backend/realtime-service/serverless.yml — provider.iam.role.statements
- Effect: Allow
  Action: [dynamodb:GetItem, dynamodb:Query]
  Resource:
    - Fn::Sub: arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${TableName}
      TableName: ${cf:${self:custom.infra}.OrdersTable}
    - Fn::Sub: arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${TableName}/index/*
      TableName: ${cf:${self:custom.infra}.OrdersTable}
    - # RestaurantsTable, RidersTable …
```

Also drop the dead `restaurant:{id}` room join (F-18) at the same time by putting
`restaurantId` into the socket bootstrap token — see §3.8.

#### Trade-offs & migration path

Adds two `GetItem`s per track request. Negligible: track happens once per order view, and
`$disconnect`/broadcast traffic dominate. Cache the principal at `$connect` (one extra row
in the connections table, or an in-module `Map` per warm container) so it is not re-read.

No client change is required — `order:track` already sends only `orderId`. The customer
tracking map continues to work because customers satisfy `order.userId === principal.sub`.

---

### 3.7 — [F-09, F-10, F-11] Concurrency defects in the repositories

Three related, individually small, collectively important defects.

#### 3.7.1 `createRider`'s uniqueness guard does not check what it claims

**File:** `packages/backend-common/src/dynamo/Rider.ts` (~line 200).

```ts
// The comment promises three checks:
  // Uniqueness guard (userId / phone / aadhaar were unique indexes):
  // cheap existence checks before the put — DynamoDB has no unique
  // constraint beyond PK.

const [byUser, byPhone] = await Promise.all([
  getRiderByUserId(input.userId),                  // ← queries user-index by userId
  docClient().send(
    new QueryCommand({
      TableName: TABLE.riders(),
      IndexName: "user-index",
      KeyConditionExpression: "userId = :u",      // ← …also queries user-index by userId
      ExpressionAttributeValues: { ":u": input.userId },
      Limit: 1,
    }),
  ),
]);
if (byUser || (byPhone.Items?.length ?? 0) > 0) { throw … }
```

`byPhone` and `byUser` are **the same query**. `phoneNumber` and `addharNumber` — the two
fields that actually ought to be unique, and the reason the comment mentions three indexes —
are **never checked**. A rider can therefore be registered twice with the same Aadhaar or
phone number. Also note `byUser` is a `DynamoRider` (truthy object) while `byPhone` is a raw
`QueryCommandOutput` — the two sides of the `||` are different shapes, so the second check
tests `.Items` on the wrong object if the branches were ever swapped.

**Fix:**

```ts
// packages/backend-common/src/dynamo/Rider.ts
const [byUser] = await Promise.all([getRiderByUserId(input.userId)]);
if (byUser) throw Object.assign(new Error("Rider already exists"), { code: "DuplicateRider" });

// If phone/aadhaar uniqueness is a real requirement (KYC implies it), it needs
// real supporting indexes — see the trade-off note below.
```

If uniqueness *is* required, add a `phone-index` GSI on `phoneNumber` and an
`aadhaar-index` on `addharNumber`, then check all three. Note that a GSI cannot be unique,
so this is still a check-then-put race — see §3.7.2.

#### 3.7.2 `createRestaurant` / `createRider` write with no condition — TOCTOU

**Files:** `Restaurant.ts:createRestaurant` (~line 170), `Rider.ts:createRider` (~line 225).

```ts
// Restaurant.ts
await docClient().send(
  new PutCommand({ TableName: TABLE.restaurants(), Item: item }),   // ⚠ no ConditionExpression
);
```

Uniqueness ("one restaurant per owner") is enforced only by the controller's pre-check:

```ts
// backend/restaurant-service/src/controllers/restaurant.ts
const existingRestaurant = await getRestaurantByOwner(String(user._id));
if (existingRestaurant) return res.status(400).json({ message: "You already have a restaurant" });
```

That is a textbook time-of-check-to-time-of-use race. A seller who double-submits the
registration form (or a retried request after a timeout) can end up owning **two** restaurants,
both `isVerified: false`, both appearing in the admin pending queue. `createUser` already
solves this properly with `attribute_not_exists(pk)` — the pattern is known in the codebase,
it just was not applied here.

**Fix** — make the write itself the guard. The `ownerId` must move into the key so the
condition can address it:

```ts
// infra/serverless.yml — add a uniqueness-enforcing GSI is NOT possible;
// instead make the owner the partition key of a dedicated "ownership" item.
OwnerLockTable:              # or reuse the restaurants table with a second item shape
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: ${self:service}-${sls:stage}-owner-locks
    BillingMode: PAY_PER_REQUEST
    KeySchema:
      - { AttributeName: pk, KeyType: HASH }        # "OWNER#<userId>"
```

```ts
// packages/backend-common/src/dynamo/Restaurant.ts
/**
 * Atomically claims "one restaurant per owner". The conditional Put IS the lock:
 * a concurrent second create gets ConditionalCheckFailedException, not a duplicate.
 */
export async function claimOwnerRestaurant(
  ownerId: string, restaurantId: string,
): Promise<boolean> {
  try {
    await docClient().send(new PutCommand({
      TableName: TABLE.ownerLocks(),
      Item: { pk: `OWNER#${ownerId}`, restaurantId, createdAt: new Date().toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return true;
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
```

Call it inside the create path and drop the controller pre-check:

```ts
// packages/backend-common/src/dynamo/Restaurant.ts
export async function createRestaurant(input: CreateRestaurantInput): Promise<DynamoRestaurant> {
  const id = randomUUID();
  const claimed = await claimOwnerRestaurant(input.ownerId, id);
  if (!claimed) return null;                       // caller maps null → 400

  const item = { pk: restaurantPk(id), sk: RESTAURANT_SK, id, … };
  await docClient().send(new PutCommand({ TableName: TABLE.restaurants(), Item: item }));
  return item;
}
```

**Migration:** add the lock table, deploy, and the behaviour is correct from the first
request. Backfill is unnecessary — for existing owners the lock row is simply absent, and the
first post-deploy create attempt writes it. Existing duplicate restaurants (if any) should be
reconciled once by hand.

#### 3.7.3 `updateRestaurantByOwner` is a lost-update

**File:** `Restaurant.ts:updateRestaurantByOwner` (~line 215).

```ts
export async function updateRestaurantByOwner(ownerId: string, updates: Partial<…>) {
  const existing = await getRestaurantByOwner(ownerId);   // read
  if (!existing) return null;
  …
  const out = await docClient().send(new UpdateCommand({    // write
    TableName: TABLE.restaurants(),
    Key: { pk: existing.pk, sk: existing.sk },
    UpdateExpression: `SET ${expr}, updatedAt = :now`,
    /* ⚠ no ConditionExpression on updatedAt */
  }));
```

There is no version check between the read and the write. Two concurrent
`PUT /api/restaurant/update` calls (e.g. the seller edits the phone while an image upload
finishes and updates the cover) interleave, and the second `SET` silently discards the
first's field. `expr` is built from `updates`, so a partial update does not overwrite
unrelated fields — but two updates to the *same* field lose one.

**Fix** — optimistic concurrency on `updatedAt`:

```ts
export async function updateRestaurantByOwner(
  ownerId: string,
  updates: Partial<Pick<DynamoRestaurant, "name" | "description" | "phone" | "image" | "isOpen">>,
): Promise<DynamoRestaurant | null> {
  const existing = await getRestaurantByOwner(ownerId);
  if (!existing) return null;

  const keys = Object.keys(updates).filter((k) => (updates as any)[k] !== undefined);
  if (keys.length === 0) return existing;

  const expr = keys.map((_, i) => `#f${i} = :v${i}`).join(", ");
  const attrNames = Object.fromEntries(keys.map((k, i) => [`#f${i}`, k]));
  const attrValues = Object.fromEntries(keys.map((k, i) => [`:v${i}`, (updates as any)[k]]));

  const out = await docClient().send(new UpdateCommand({
    TableName: TABLE.restaurants(),
    Key: { pk: existing.pk, sk: existing.sk },
    UpdateExpression: `SET ${expr}, #ua = :now`,
    ConditionExpression: "#ua = :expected",          // ← optimistic lock
    ExpressionAttributeNames: { ...attrNames, "#ua": "updatedAt" },
    ExpressionAttributeValues: { ...attrValues, ":now": new Date().toISOString(), ":expected": existing.updatedAt },
    ReturnValues: "ALL_NEW",
  })).catch(() => null);                              // conflict ⇒ null

  return (out?.Attributes as DynamoRestaurant) ?? null;
}
```

And surface the conflict as a **409**, not a silent success — the caller must retry:

```ts
// backend/restaurant-service/src/controllers/restaurant.ts
const restaurant = await updateRestaurantByOwner(String(user._id), updateFields);
if (!restaurant) {
  return res.status(409).json({ message: "Restaurant was modified elsewhere — retry" });
}
```

#### Trade-offs & migration path

The `updatedAt` condition is a **breaking change for existing writers** that do not pass the
expected value — but `updateRestaurantByOwner` is the only writer of restaurant fields, and
all call sites go through it, so this is a single-file change plus one caller. `setRestaurantOpen`
delegates to the same function, so it inherits the fix for free.

For §3.7.2, the owner-lock table is a new resource with no data migration. If you would
rather avoid a new table, the alternative is to key the restaurant item as
`pk = OWNER#<ownerId>` and store the id as an attribute — but that would break every
`RESTAURANT#<id>` direct lookup the order flow depends on, so it is **not** worth it.

---

### 3.8 — [F-18] The 7-day JWT defeats the minimal-claims design and forces the dual-emit

**Files:**
- `backend/restaurant-service/src/controllers/restaurant.ts` (~line 95)
- `backend/realtime-service/src/config/websocket.ts` (`handleConnect`)
- `backend/auth-service/src/controllers/socket-token.ts`

#### Impact & why it fails

```ts
export const getMyRestaurant = tryCatch(async (req, res) => {
  const restaurant = await getRestaurantByOwner(String(user._id));
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

  if (!user.restaurantId) {
    const token = jwt.sign(
      { user: { ...user, restaurantId: restaurant.id } } as any,   // ⚠ nested legacy shape
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },                                        // ⚠ 672× the 15-min TTL
    );
    return res.status(200).json({ message: "…", restaurant, token });
  }
  return res.status(200).json({ message: "…", restaurant });
});
```

Three cascading problems:

1. **7 days vs 15 minutes.** The whole token model is justified by "short-lived access JWT +
   revocable refresh". A 7-day signed token is neither. If it leaks — and it is returned in a
   JSON body, so it can reach `sessionStorage`, a log, or a proxy — the attacker has a week.
2. **The gateway authorizer accepts it.** `jwt.verify(token, JWT_SECRET)` succeeds and `sub`
   is present, so it authorises exactly like a 15-minute token. Nothing distinguishes them.
3. **It forces two shims elsewhere**, both of which are latent bugs:
   - `backend-common/src/middlewares/isAuth.ts`: `if (payload.user) payload = payload.user`
   - `backend/realtime-service/src/config/websocket.ts`: `const userData = decoded.user || decoded`

   The second one is why the `restaurant:{restaurantId}` room join exists at all. But the
   **modern** token issued by `signAccessToken` carries only `{ sub, role, typ }` — no
   `restaurantId`. So that join never fires for current clients, and `restaurant:{id}` has
   essentially **zero subscribers**.

   Every publisher therefore compensates with a second emit to the owner's user room:

   ```ts
   // backend/restaurant-service/src/config/consumers.ts — onPaymentSuccess
   await publishRealtimeEvent("order:new", `restaurant:${order.restaurantId}`, { orderId });
   const restaurant = await getRestaurantById(order.restaurantId);
   if (restaurant) {
     await publishRealtimeEvent("order:new", `user:${restaurant.ownerId}`, { orderId }); // ← the one that works
   }
   ```

   That extra `getRestaurantById` runs on **every** payment success and **every** status
   change — a read per event purely because of this token defect.

#### Current vulnerable code

Reproduced above. Note also that `req.user` here comes from the **permissive** `isAuth`, which
normalises `sub`/`id`/`_id`, so `user.restaurantId` is `undefined` for every current caller —
**the branch that mints the 7-day token is effectively dead code**, yet it still widens the
attack surface of the endpoint.

#### Target implementation

Put the data where it belongs — in the short-lived socket token — and delete the legacy path.

```ts
// backend/auth-service/src/controllers/socket-token.ts
import { getRestaurantByOwner } from "@foodo/backend-common/dynamo";

export const getSocketToken = tryCatch(async (req: AuthRequest, res: Response) => {
  const claims = req.user as AccessClaims;

  // Role + ownership, in a token that lives 15 minutes and only in memory.
  const restaurant = await getRestaurantByOwner(claims.sub);
  const payload: AccessClaims & { restaurantId?: string } = {
    sub: claims.sub,
    role: claims.role,
    typ: "access",
    ...(restaurant ? { restaurantId: restaurant.id } : {}),
  };

  return res.status(200).json({
    message: "Socket token issued",
    token: signAccessToken(claims.sub, claims.role, payload),
    expiresIn: 15 * 60,
  });
});
```

```ts
// backend/realtime-service/src/config/websocket.ts — handleConnect
const decoded = jwt.verify(cleanToken, JWT_SECRET) as SocketPrincipal & { restaurantId?: string };
const userId = decoded.sub ?? (decoded as any).user?._id;    // legacy fallback, remove after §3.8 ships
await joinRoom(connectionId, `user:${userId}`);
if (decoded.restaurantId) await joinRoom(connectionId, `restaurant:${decoded.restaurantId}`);  // ← now fires
```

Then remove the token minting entirely:

```ts
// backend/restaurant-service/src/controllers/restaurant.ts
export const getMyRestaurant = tryCatch(async (req: AuthRequest, res) => {
  const restaurant = await getRestaurantByOwner(String(user._id));
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });
  setCacheablePrivate(res, 5);
  return res.status(200).json({ message: "Restaurant fetched successfully", restaurant });
});
```

Only **after** that has shipped and you are confident no legacy client is running, delete the
two legacy shims (`decoded.user || decoded` and the `payload.user` unwrap in `isAuth`).

#### Trade-offs & migration path

The socket token now costs one extra `GetItem` per socket connect — negligible, and
connections are rare compared to events. Do the room-join fix **first** (it is additive and
makes sellers receive events twice for one deploy), then delete the 7-day token, then the
shims. That order means no window in which a seller loses live updates.

---

### 3.9 — [F-14] `tryCatch` turns every authorization failure into a 500

**Component:** 14 handlers in `restaurant-service`, all of `rider-service`.
**Files:** `packages/backend-common/src/middlewares/trycatch.ts` vs. the controllers.

#### Impact & why it fails

```ts
// packages/backend-common/src/middlewares/trycatch.ts — the plain variant
export const tryCatch =
  (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (error: any) { return res.status(500).json({ message: error.message }); }
  };
```

Meanwhile the controllers throw bare `Error`s for authorization failures:

```ts
// backend/restaurant-service/src/controllers/order.ts
if (!user) throw new Error("Unauthorized");
if (!restaurant || restaurant.ownerId !== String(user._id)) throw new Error("Unauthorized");
if (order.userId !== String(user._id)) throw new Error("Unauthorized");
```

Result: a customer requesting someone else's order gets **HTTP 500**, not 401 or 403.

This is not merely cosmetic. The frontend's entire session-recovery mechanism keys on 401:

```ts
// apps/web/src/lib/api-client.ts
const exempt = AUTH_RETRY_EXEMPT.some((p) => url.startsWith(p));
if (status === 401 && !exempt) {
  await refreshSession();     // ← only fires on 401
  return requestOnce<T>(url, config);
}
throw error;
```

So when an access token expires and the request hits a route that throws `Unauthorized`, the
user gets a **hard error screen instead of a silent token refresh**. `admin-service` already
has the correct variant (`tryCatchStatus`, which honours `error.status`) — the fix exists in
the codebase and was simply not propagated.

#### Current vulnerable code

Reproduced above. Affected: `createOrder`, `fetchRestaurantOrders`, `getRestaurantAnalytics`,
`updateOrderStatus`, `cancelOrderController`, `getMyOrders`, `getOrderPaymentStatus`,
`fetchSingleOrder`, plus `createRiderController`, `fetchMyProfile`, `createAddressController`
and others.

Note the **inconsistency within the same file** — cart controllers do it correctly:

```ts
// backend/restaurant-service/src/controllers/cart.ts — correct
if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
```

#### Target implementation

```ts
// packages/backend-common/src/middlewares/trycatch.ts
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const Unauthorized = (m = "Unauthorized") => new HttpError(401, m);
export const Forbidden    = (m = "Forbidden")    => new HttpError(403, m);
export const NotFound     = (m = "Not found")    => new HttpError(404, m);
export const BadRequest   = (m = "Bad request")  => new HttpError(400, m);
export const Conflict     = (m = "Conflict")     => new HttpError(409, m);

/** Status-preserving. Replaces BOTH tryCatch and tryCatchStatus. */
export const tryCatch =
  (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (error: any) {
      const status =
        typeof error?.status === "number" && error.status >= 400 && error.status < 600
          ? error.status : 500;
      if (status >= 500) console.error(`[${req.method} ${req.path}]`, error);
      res.status(status).json({ error: { code: error?.code ?? "ERROR", message: error.message } });
    }
  };
```

```ts
// backend/restaurant-service/src/controllers/order.ts — mechanical, per-site
import { tryCatch, Unauthorized, Forbidden } from "@foodo/backend-common";

if (!user) throw Unauthorized();
if (!restaurant || restaurant.ownerId !== String(user._id)) throw Forbidden("Not your restaurant");
if (order.userId !== String(user._id)) throw Forbidden("Not your order");
```

Adopting the `{"error": {code, message}}` envelope also closes **F-20** (see §3.13).

#### Trade-offs & migration path

**Client-breaking for error shapes.** The frontend reads
`error.response.data?.message`, so wrap once in `api-client.ts`:

```ts
throw new ApiError(
  error.response.data?.error?.message ?? error.response.data?.message ?? error.message,
  error.response.status,
  error.response.data,
);
```

Roll out per service (restaurant first — it has the most affected handlers), and keep
`tryCatchStatus` as a deprecated alias for one release so `admin-service` needs no change.

---

### 3.10 — [F-36] `isSeller` / `isAdmin` fail **open** when `req.user` is unset

**File:** `packages/backend-common/src/middlewares/isAuth.ts`.

#### Impact & why it fails

```ts
export const isSeller = (req, res, next) => {
  const user = req.user;
  if (user && user.role !== "seller") {          // ⚠ falsy guard
    return res.status(401).json({ message: "You are not authorized seller" });
  }
  next();                                          // ← reached when user is undefined
};

export const isRider = (req, res, next) => {
  const user = req.user;
  if (!user || user.role !== "rider") {           // ✓ correctly fail-closed
    return res.status(401).json({ message: "You are not authorized rider" });
  }
  next();
};
```

`isSeller` and `isAdmin` reject only a *present* user with the wrong role. A request with
**no** user at all passes straight through. `isRider` is the correct inverse.

The source comments this honestly as preserved semantics — but "preserved" is not "safe".
Today the gateway authorizer blocks anonymous traffic first, so the hole is closed in
production. It becomes exploitable the moment any of these routes is made public, an
authorizer is bypassed, or `req.user` fails to populate — e.g. if `event.requestContext.authorizer.lambda`
is ever absent and the session cookie is malformed, `jwt.decode` returns `null`, and
`isAuth` returns 401… which is fine. The real exposure is the **route-order** case:

```ts
// backend/restaurant-service/src/routes/restaurant.ts
router.use(isAuth, isSeller);            // guards only what FOLLOWS
router.get('/all', getAllRestaurants)     // ⚠ declared ABOVE the guard → unguarded by design
router.get('/nearby', getNearbyRestaurants)
```

That ordering is intentional today, but it means the guard's fail-open behaviour is one
refactor away from mattering.

#### Current vulnerable code

Reproduced above.

#### Target implementation

```ts
export const isSeller: RequestHandler = (req, res, next) => {
  if (!req.user)            return res.status(401).json({ message: "Unauthorized" });
  if (req.user.role !== "seller") return res.status(403).json({ message: "You are not authorized seller" });
  next();
};
// isAdmin identical; isRider already correct — align the status codes too (401 vs 403).
```

#### Trade-offs & migration path

**Pure hardening** — no legitimate caller is affected, because reaching `isSeller` without
`isAuth` has never been a valid flow. Ship with the §3.9 error-envelope change so the
responses stay consistent.

---

### 3.11 — [F-16] Post-read `FilterExpression` silently truncates paginated results

**Files:** `packages/backend-common/src/dynamo/Order.ts` (`listOrdersByUser`, `listOrdersByRestaurant`, `listDeliveredOrdersByRider`).

#### Impact & why it fails

```ts
const out = await docClient().send(new QueryCommand({
  TableName: TABLE.orders(),
  IndexName: "user-orders",
  KeyConditionExpression: "userId = :u",
  FilterExpression: "paymentStatus = :paid",        // ⚠ NOT part of the key
  ExpressionAttributeValues: { ":u": userId, ":paid": "paid" },
  ScanIndexForward: false,
  Limit: limit,                                     // ⚠ counts PRE-filter rows
}));
return (out.Items as DynamoOrder[]) ?? [];
```

In DynamoDB, `Limit` bounds the number of items **evaluated** before the filter, not the
number returned. A user with 500 orders, 450 of them unpaid, asks for 50 → DynamoDB reads
50 rows, discards all 50 as unpaid, returns `[]`. The UI shows "No orders yet" for a user
with 400 paid orders.

This compounds with pagination: `listOrdersByRestaurant` sets `nextCursor` from
`page[page.length - 1]` — if the page is empty after filtering, `last` is `undefined` and the
cursor becomes `null`, so **keyset pagination silently terminates early**.

#### Current vulnerable code

Reproduced above.

#### Target implementation

Move `paymentStatus` into the sort key so it is a true key condition:

```yaml
# infra/serverless.yml — OrdersTable GSIs
- IndexName: user-orders
  KeySchema:
    - { AttributeName: userId, KeyType: HASH }
    - { AttributeName: paymentStatus, KeyType: RANGE }   # ← was createdAt
  Projection: { ProjectionType: ALL }
```

That changes ordering, so add a **second** GSI rather than repurposing the existing ones
(createdAt ordering is what powers "newest first"):

```yaml
- IndexName: user-orders-paid
  KeySchema:
    - { AttributeName: userId, KeyType: HASH }
    - { AttributeName: paymentStatus, KeyType: RANGE }
    - { AttributeName: createdAt, KeyType: RANGE }       # DynamoDB supports 3-part keys on a GSI sort
  Projection: { ProjectionType: ALL }
```

```ts
export async function listOrdersByUser(userId: string, limit = 50): Promise<DynamoOrder[]> {
  const out = await docClient().send(new QueryCommand({
    TableName: TABLE.orders(),
    IndexName: "user-orders-paid",
    KeyConditionExpression: "userId = :u AND paymentStatus = :paid",   // ← key, not filter
    ExpressionAttributeValues: { ":u": userId, ":paid": "paid" },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (out.Items as DynamoOrder[]) ?? [];
}
```

For the keyset case, guard the empty-page branch explicitly so the cursor can never go null
on a filtered result:

```ts
if (hasMore && last) return { orders: page, nextCursor: `${last.createdAt}|${last.id}` };
return { orders: page, nextCursor: null };
```

#### Trade-offs & migration path

Adding GSIs to a hot table is a **blocking** CloudFormation operation — do it in a
low-traffic window. GSIs backfill asynchronously; deploy the code that *reads* the new index
only after `ListTables`/describe confirms the index is `ACTIVE`, or you will get
`ValidationException` on the first request. Zero-downtime sequence: add index → wait for
ACTIVE → deploy reader → (optionally) drop old indexes.

Interim, one-line mitigation with no schema change: loop with `LastEvaluatedKey` until
`limit` rows **survive** the filter.

---

### 3.12 — [F-12] No edge rate limiting; every limiter is per warm Lambda container

**Files:** `core/serverless.yml` (no throttling), all `rate-limit.ts`.

#### Impact & why it fails

`backend/utils-service/src/config/rate-limit.ts` states the position explicitly:

> *The old Redis-backed store is gone: each Lambda container is a short-lived isolated
> process, so a shared external counter would be the only correct store — and that now belongs
> at the edge, not in app code.*

The edge enforcement point **does not exist**. Concretely: a `limit: 20` per-IP flood guard
actually permits up to `20 × (number of concurrent warm containers)` attempts per window,
because each container has its own counter. Under sustained attack the container pool scales
out, and the effective limit scales with it — the limiter gets **weaker precisely when it is
needed most**. `authFloodLimiter` and `bruteForceLimiter` are both affected, as are the
payment-create and webhook limiters.

#### Current vulnerable code

```ts
export const paymentCreateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,                       // per container, not per IP globally
  message: { message: "Too many payment attempts — slow down" },
});
```

```yaml
# core/serverless.yml — HttpApiStage has no DefaultRouteSettings
HttpApiStage:
  Type: AWS::ApiGatewayV2::Stage
  Properties:
    ApiId: !Ref HttpApi
    StageName: $default
    AutoDeploy: true
```

#### Target implementation

```yaml
# core/serverless.yml
HttpApiStage:
  Type: AWS::ApiGatewayV2::Stage
  Properties:
    ApiId: !Ref HttpApi
    StageName: $default
    AutoDeploy: true
    DefaultRouteSettings:                       # ← the real per-IP throttle
      ThrottlingBurstLimit: 200
      ThrottlingRateLimit: 100
```

Keep the in-app limiters as defence in depth — they now protect per-account
(`bruteForceLimiter` is keyed by IP **and** email, which the edge cannot see) rather than
trying to be the only line.

#### Trade-offs & migration path

Pure infrastructure addition, no code change, and independently deployable. Tune
`ThrottlingRateLimit` against observed p99 traffic before enforcing; a mis-set rate on a
gateway stage produces a platform-wide outage, so start with a generous burst and alert on
`4XX`/`5XX` for a week.

---

### 3.13 — [F-19, F-20] No correlation IDs, no error envelope

**Files:** all services; `apps/web/src/lib/api-client.ts`.

#### Impact

Two compounding observability gaps. First, the gateway logs a `requestId` but **nothing
propagates it into the Lambda**, so correlating one user action across gateway → service →
SNS → consumer requires timestamp guessing. Second, there are at least **five** error
response shapes in production:

| Shape | Where |
|---|---|
| `{ message }` | `tryCatch` |
| `{ success, message }` | cart + address controllers |
| `{ success: true, data }` | restaurant controllers |
| `{ message, restaurant }` | seller write endpoints |
| `{ count, restaurants }` | admin |

The client copes with this by guessing:

```ts
throw new ApiError(
  error.response.data?.message || error.message || "Request failed",
  error.response.status, error.response.data,
);
```

…which silently returns `"Request failed"` for any of the four shapes that lack `message`.

#### Target implementation

Propagate the request ID and log structurally:

```ts
// packages/backend-common/src/middlewares/context.ts — NEW
import { randomUUID } from "crypto";
import type { RequestHandler } from "express";

export const requestContext: RequestHandler = (req, res, next) => {
  const id =
    req.headers["x-amzn-trace-id"]?.toString().split(";")[0] ??
    req.headers["x-request-id"]?.toString() ??
    randomUUID();
  res.setHeader("x-request-id", id);
  (req as any).requestId = id;
  next();
};

export const log = (req: any, level: "info" | "warn" | "error", msg: string, extra = {}) =>
  console[level](JSON.stringify({ requestId: req.requestId, method: req.method, path: req.path, msg, ...extra }));
```

```ts
// every service index.ts — before the routers
app.use(requestContext);
```

```ts
// trycatch.ts — structural, correlated
if (status >= 500) log(req, "error", error.message, { stack: error.stack, status });
res.status(status).json({
  error: { code: error?.code ?? "INTERNAL_ERROR", message: error.message, requestId: req.requestId },
});
```

Client side, read the header so a user can quote it in a support ticket:

```ts
export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown,
              public requestId?: string) { super(message); this.name = "ApiError"; }
}
```

#### Trade-offs & migration path

The envelope change is **client-breaking** — mitigated by the fallback shim in §3.9. Introduce
`requestId` first (purely additive: new response header + structured logs) so the correlation
capability exists before you change any payload shape, then roll the envelope out per service
with the frontend shim deployed first.

---

### 3.14 — [F-21, F-22, F-23, F-24] Frontend hygiene and one dangerous type

**Files:** `query-provider.tsx:31`, `lib/socket-events.ts:49,59`, `seed/demo-users.ts`, `controllers/auth.ts`.

**(a) `ReactQueryDevtools` ships to production.** Rendered unconditionally:

```tsx
<QueryClientProvider client={queryClient}>
  {children}
  <ReactQueryDevtools initialIsOpen={false} />     // ⚠ no NODE_ENV guard
</QueryClientProvider>
```

It is a `devDependencies` entry but the import is unconditional, so it is bundled into the
client chunk — extra KB plus an in-app view of every query and its cached data.

```tsx
{process.env.NODE_ENV === "development" && <ReactQueryDevtools initialIsOpen={false} />}
```

**(b) `RiderAssignedPayload` describes a shape the server never sends.**

```ts
// apps/web/src/lib/socket-events.ts:46-52
export interface RiderAssignedPayload {
  order: { _id: string; restaurantId: string; status: string; riderId?: string;
           riderName?: string; riderPhone?: number; };     // ⚠ _id + riderPhone: number
}
```

The server publishes `{ order }` where `order` is a raw `DynamoOrder` — which has `id`, not
`_id`, and `riderPhone: string | number | null`. Both fields are wrong. This is the type-level
twin of F-01 and would be caught by deriving it:

```ts
export interface RiderAssignedPayload { order: Wire<DynamoOrder> }
```

**(c) Committed demo credentials.** `backend/auth-service/src/seed/demo-users.ts` contains
`customer123`, `restaurant123`, `rider123` — in the repository, hashed with bcrypt cost 10,
and idempotent, so a deploy-to-prod plus one manual invoke creates three usable accounts.
There is no environment guard:

```ts
export const seedDemoUsers = async (): Promise<void> => {
  for (const demo of DEMO_USERS) { … }      // ⚠ runs wherever it is invoked
};
```

```ts
export const seedDemoUsers = async (): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo accounts in production");
  }
  …
};
```

**(d) No server-side password policy.** The frontend Zod schema enforces `min(6)`; the
Cognito pool policy says 8 with upper/lower/number; auth-service enforces **nothing** —
`bcrypt.hash(password, 10)` on whatever arrives. A policy that lives only in the browser is
not a policy. This is fixed by the shared schemas in §3.3:

```ts
export const Password = z.string().min(8).max(128)
  .regex(/[a-z]/, "needs a lowercase letter")
  .regex(/[A-Z]/, "needs an uppercase letter")
  .regex(/\d/, "needs a digit");
```

---

### 3.15 — Remaining lower-severity findings

| ID | Finding | Fix |
|---|---|---|
| F-17 | `listReadyOrders(200)` then in-memory filter — a nearby order past the cap is invisible | Paginate `status-board`, or denormalise the restaurant's geo onto the order |
| F-25 | `makeFanoutPublisher` swallows every error; a lost `order:new` leaves the seller board stale with no recovery | For money- or business-critical events, write an outbox item in the same `TransactWrite` as the state change, then relay to SNS |
| F-26 | Reconnect backoff `500ms × 2^n`, no jitter → thundering herd on realtime cold start | `delay = min(500 * 2**n, 5000) * (0.5 + Math.random())` |
| F-27 | GSI doc comments claim sort keys that do not exist: `Restaurant.ts:18-21` says `verified-index PK=isVerified SK=name`, `owner-index SK=createdAt`; `Rider.ts:15-19` says `user-index SK=createdAt`, `verified-index SK=createdAt`. `infra/serverless.yml` defines **all** of these as HASH-only | Fix the comments, or better: add a CI check that parses `infra/serverless.yml` and asserts the documented key schema matches |
| F-28 | `backend/restaurant-service/src/lib/distance.ts` is a byte-identical duplicate of `packages/backend-common/src/aws/geo.ts` | Delete the local copy; `deliveryDistanceKm` is already imported from the shared package |
| F-29 | `backend/admin-service/src/controllers/admin.ts` — `void listReadyOrders;` suppresses a lint error for an unused import | Delete the import |
| F-31 | `packages/backend-common/src/cloudinary.ts` and `cloudinary/upload.ts` both exist; the second is a one-line re-export | Fold into `cloudinary/index.ts` |
| F-32 | S3 uploads bucket, Cognito pool and an empty VPC are provisioned and exported but unused | Adopt or delete; each has carrying cost and confuses new engineers |
| F-33 | `listVerifiedRestaurants` has no `Limit` — returns every verified restaurant, paginated by the SDK internally | Add a `Limit` + cursor, or rely on the edge cache and cap the catalogue |
| F-34 | `backend/*/tsup.config.ts` sets `sourcemap: true` for production bundles | Gate on `NODE_ENV !== "production"`, or ship `.map` files to a separate bucket with restricted IAM |
| F-35 | `apps/web/src/app/layout.tsx` uses `dangerouslySetInnerHTML` for the theme script and applies `suppressHydrationWarning` twice; no CSP anywhere | Move to a hashed external script and add a `Content-Security-Policy` response header at CloudFront |
| F-30 | Root `README.md` documents MongoDB, RabbitMQ and Socket.IO — two architectures out of date. `infra/README.md` still says the HTTP API has "CORS" when it has none by design | Replace both with a pointer to `docs/` |

---

## Section 4: Prioritized Technical Debt Roadmap

### Phase 1 — Immediate (P0): security holes, data corruption, render-breaking defects

Ship as a single week. Items 1–3 are **currently breaking the product**; they are not
improvements.

| # | Item | Flaw | Effort | Owner surface |
|---|---|---|:--:|---|
| 1.1 | Restore the `_id` wire contract via `toWire()` at every egress (§3.1) | F-01 | 4 h | Customer, seller, rider, admin UIs |
| 1.2 | Fix `cloudinary-upload.ts` to replay `signedParams`; rename env vars to `CLOUDINARY_{CLOUD_NAME,API_KEY,API_SECRET}` (§3.2) | F-02, F-15 | 2 h | All image upload |
| 1.3 | Authorize `order:track` **and** `rider:location` in `wsRouter` (§3.6) | F-07 | 3 h | Realtime IAM + handler |
| 1.4 | Delete the 7-day JWT from `getMyRestaurant`; add `restaurantId` to the socket token (§3.8) | F-08, F-18 | 3 h | Restaurant + auth + realtime |
| 1.5 | Gate the demo-account seeder behind `NODE_ENV !== production` (§3.14c) | F-23 | 1 h | Auth service |
| 1.6 | Make `isSeller` / `isAdmin` fail **closed** when `req.user` is unset (§3.10) | F-36 | 1 h | Shared middleware (all services) |
| 1.7 | Replace `throw new Error("Unauthorized")` with a status-carrying `HttpError`; unify on `tryCatch` (§3.9) | F-14 | 2 h | All order handlers |

**Definition of done for P0:** `pnpm build` green; one integration test asserting `_id` on
every list endpoint; one asserting a 401 (not 500) on an unauthorized order fetch; one
asserting `order:track` returns 403 for a non-owner.

> **Do not skip 1.1.** Every other UI fix is unverifiable while pages throw during render.

---

### Phase 2 — Near-Term (P1): decoupling, indexing, correctness of scale

| # | Item | Flaw | Effort | Rationale |
|---|---|---|:--:|---|
| 2.1 | Add `geo-index` (geohash) to riders + restaurants; backfill, dual-write, flip reader (§3.4) | F-04, F-06 | 2 d | The #1 delivery-path scalability risk. Until it ships, add `Limit` as a stopgap. |
| 2.2 | Replace the admin orders `Scan` with Streams-fed counters (§3.5) | F-05 | 2 d | Currently **silently wrong** past 1 MB, not merely slow |
| 2.3 | Adopt Zod validation middleware route-by-route, money paths first (§3.3) | F-03 | 3 d | Blocks negative prices, `NaN` coordinates, unknown payment methods |
| 2.4 | Fix `createRider` duplicate guard; add owner-lock + optimistic concurrency (§3.7) | F-09, F-10, F-11 | 2 d | Real race conditions on writes |
| 2.5 | Add `paymentStatus` to the order GSIs so `FilterExpression` stops truncating pages (§3.11) | F-16 | 1 d | Pages silently return short; cursors terminate early |
| 2.6 | Paginate `listReadyOrders`; cap the `order:available` fan-out (§3.15) | F-17, F-25 | 1 d | Prevent invisible orders + broadcast storms |
| 2.7 | Add API Gateway stage throttling (§3.12) | F-12 | 3 h | Makes rate limiting real; all current limits are per-container |
| 2.8 | Standardise the error envelope; add a correlation ID end to end (§3.13) | F-19, F-20 | 3 d | Debuggability is currently guesswork |
| 2.9 | Remove `ReactQueryDevtools` from production bundles (§3.14a) | F-21 | 15 min | Free bundle + leak reduction |
| 2.10 | Derive socket payload types from the server shapes (§3.14b) | F-22 | 30 min | Types currently describe fiction |

---

### Phase 3 — Long-Term (P2): structural work, contracts, hardening

| # | Item | Flaw | Effort | Rationale |
|---|---|---|:--:|---|
| 3.1 | **Stand up a test harness.** Vitest + `aws-sdk-client-mock`, DynamoDB Local for integration | F-13 | 1 wk | Everything else is unverifiable until this exists. Seed with the saga + payment claim + refresh rotation paths. |
| 3.2 | Split `order.ts` (≈600 lines, 9 handlers) into `order/`, `order-analytics/`, `order-claim/` modules | Modularity | 2 d | God-object; every reviewer reads 600 lines for any order change |
| 3.3 | Publish OpenAPI from the Zod schemas; generate frontend clients | F-03 | 1 wk | Ends the `id`/`_id` class of bug permanently; contract tests become free |
| 3.4 | Adopt DynamoDB **TransactWrite outbox** for any domain event that must not be lost, replacing the fire-and-forget publisher where it matters | F-25 | 3 d | Currently a lost `order:new` is unrecoverable |
| 3.5 | Introduce distributed tracing (OTel + `x-amzn-trace-id`) across gateway → Lambda → SNS → consumer | F-19 | 1 wk | Required before you can debug the saga in production |
| 3.6 | Migrate auth to the provisioned Cognito pool; delete the dual-stack token model | F-08 | 3 d | The pool already exists; the authorizer swap is the whole change |
| 3.7 | Reconcile GSI doc comments with `infra/serverless.yml`; delete duplicated `distance.ts`, dead `void listReadyOrders` (§3.15) | F-27, F-28, F-29 | 2 h | Stops the next engineer trusting a comment |
| 3.8 | Decide the fate of unused infrastructure: S3 uploads bucket, Cognito (or adopt), empty VPC | F-32 | 1 d | Carrying cost + confusion |
| 3.9 | Rewrite `README.md`; make `docs/` the source of truth; add a docs CI check | F-30 | 1 d | Current README documents a platform that no longer exists |
| 3.10 | Add jitter to socket reconnect; review reconnection under load | F-26 | 1 h | Prevents thundering herd on realtime cold start |
| 3.11 | Add a Content-Security-Policy and remove the inline theme script | F-35 | 3 h | Hardening |
| 3.12 | Server-side password policy (§3.14d) | F-24 | 2 h | Policy must not live in the browser |

---

### Cross-cutting sequencing advice

**The two changes that unlock everything else are 1.1 (`_id`) and 3.1 (tests).** Today the
UI throws during render, so UI work cannot be validated; and with no tests, every refactor
above is a gamble on the money paths. Do those first even though neither is "architecture".

**A useful ordering property:** the P0 set is entirely backward compatible. `toWire` adds a
field the client already expects; `signedParams` adds a field an old client ignores; the
7-day token removal deletes a field the current frontend does not read; `order:track`
authorisation adds a check behind an existing call. So P0 can ship in one deploy with no
version skew and no client release.

**The one genuinely invasive change is 2.1** (geohash index). Budget a week, run it in the
dual-write shadow described in §3.4, and do not attempt it during a busy trading period.

---

## Appendix A — Verification commands

Every finding in this document is reproducible:

```bash
# F-01 — no id→_id mapping outside auth-service
grep -rn "_id:" apps/web/src --include=*.ts --include=*.tsx | grep -v "restaurantId: {"
grep -rn "interceptors" apps/web/src                          # → none
grep -n "_id" backend/restaurant-service/src/controllers/order.ts   # → only req.user._id

# F-02 — client drops signed params
sed -n '30,45p' apps/web/src/lib/cloudinary-upload.ts
grep -n "params.tags\|params.transformation" packages/backend-common/src/cloudinary.ts

# F-03 — no server-side validation
grep -rn 'from "zod"' backend/ packages/ core/ --include=*.ts   # → none

# F-04 / F-06 — unbounded geo queries (no Limit present)
grep -n "Limit" packages/backend-common/src/dynamo/Rider.ts
grep -n "FilterExpression" packages/backend-common/src/dynamo/Rider.ts

# F-05 — orders Scan
grep -n "ScanCommand" backend/admin-service/src/controllers/admin.ts

# F-09 — the duplicated uniqueness check
sed -n '/Uniqueness guard/,/^  const id = randomUUID/p' packages/backend-common/src/dynamo/Rider.ts

# F-13 — no tests
find . -name "*.test.ts" -o -name "*.spec.ts" | grep -v node_modules    # → none

# F-15 — wrong Cloudinary env names
grep -rn "CLOUDINARY" backend/*/serverless.yml
grep -n "CLOUDINARY_" packages/backend-common/src/cloudinary.ts

# F-21 — devtools in production
grep -n "ReactQueryDevtools" apps/web/src/providers/query-provider.tsx

# F-23 — committed demo credentials
grep -n "password:" backend/auth-service/src/seed/demo-users.ts

# F-36 — fail-open role guards
sed -n '/export const isSeller/,/^};/p' packages/backend-common/src/middlewares/isAuth.ts

# F-16 — post-read FilterExpression truncates pages
grep -n "FilterExpression\|Limit" packages/backend-common/src/dynamo/Order.ts

# F-27 — GSI doc drift
grep -n "GSI-" packages/backend-common/src/dynamo/Restaurant.ts packages/backend-common/src/dynamo/Rider.ts
grep -A3 "verified-index" infra/serverless.yml
```

## Appendix B — Documentation map

For narrative documentation of the system (architecture narrative, data model, event
catalogue, operational runbooks, and a broader FAQ) see the companion set:

| Document | Covers |
|---|---|
| `docs/00-index.md` … `docs/14-known-gaps.md` | Full platform documentation, incl. a non-audited gap register |
| `docs/foodo-platform-architecture.html` | Rendered architecture diagram |

Where this audit and the companion docs disagree, **this audit reflects deeper inspection**
and takes precedence.