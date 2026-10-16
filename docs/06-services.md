# 06 — Services Reference

Six backend services, each an independent Serverless Framework stack. Every one mounts
Express on Lambda via `serverless-http`.

Common per-service shape:

```ts
// index.ts
export const app = express();
app.use(cookieSession({ name: "session", keys: [COOKIE_SECRET], maxAge: 24h }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/<prefix>", router);
app.get("/health", …);
```

```ts
// handlers/http.ts (or index.ts directly)
const serverlessApp = serverlessHttp(app);
export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context);
};
```

There is **no `connectDB()`** anywhere. DynamoDB needs no connection setup; the SDK
document client is a lazily-created warm singleton.

---

## 1. auth-service — `foodo-auth`

`backend/auth-service/` · Lambda: `http` only · 512 MB / 15 s

### Files
```
src/index.ts             Express + cookieParser + cookieSession; mounts /api/auth
src/routes/auth.ts       6 routes
src/controllers/auth.ts  register, login, refresh, /me, logout
src/controllers/socket-token.ts
src/lib/tokens.ts        access JWT, refresh cookie options, cookie-session options
src/middlewares/isAuth.ts   STRICT variant
src/middlewares/rate-limit.ts
src/seed/demo-users.ts
```

### Data
Reads/writes only the **users** table. Has `sns:Publish` on the events topic (the seeded
demo path is the only current use).

### Behaviour
Full detail in [05 Authentication](./05-authentication.md).

### Notable
- `app.set("trust proxy", 1)` so secure-cookie logic and IP detection see the real client
  IP behind CloudFront/API Gateway.
- `body-parser` is **not** used — the handlers read `req.body` directly, which
  `serverless-http` already parses.
- `demo-users.ts` is a seed helper for local work.

---

## 2. restaurant-service — `foodo-restaurant`

`backend/restaurant-service/` · Lambdas: `http`, `paymentConsumer`, `riderEventsConsumer`
· 512 MB / 15 s (consumers 30 s)

### The biggest service — 5 routers, 6 tables, 2 consumers

```
src/index.ts                 Express app, scoped 10 MB parsers, mounts 5 routers
src/handlers/http.ts         http Lambda entry
src/handlers/paymentConsumer.ts
src/handlers/riderEventsConsumer.ts
src/config/events.ts         3 publishers (fanout / domain / SQS work item)
src/config/consumers.ts      ALL consumer logic lives here
src/controllers/{order,cart,menuItem,restaurant,address,upload}.ts
src/dynamo/cart.ts           cart + menu-item + address repositories (service-local)
src/lib/distance.ts          local haversine copy (legacy)
src/routes/{order,cart,menu-item,restaurant,address}.ts
src/seed/demo-restaurant.ts
```

### Routers and their guards

| Mount | Router | Guard strategy |
|---|---|---|
| `/api/restaurant` | `restaurantRouter` | mixed: public `/all`, `/nearby`, `/:id`; `/my` + `/upload-signature` explicit; then `router.use(isAuth, isSeller)` for `/new`, `/update`, `/status` |
| `/api/menu-item` | `menuItemRouter` | `router.use(isAuth)`, then `isSeller` per write route; `/all/:id` is public at the gateway |
| `/api/cart` | `cartRouter` | `router.use(isAuth)` for everything |
| `/api/order` | `orderRouter` | per-route `isAuth` + `isSeller` |
| `/api/address` | `addressRoute` | `router.use(isAuth)` |

⚠️ **Route-order dependency:** `/restaurant/my` must be declared **before** `/:id`, and
`/order/analytics/:restaurantId` **before** `/:orderId`, or Express captures
`"my"` / `"analytics"` as an id. Same discipline at the gateway, where literal paths beat
`{proxy+}`.

### Body limits — scoped, not global

```ts
app.use(["/api/menu-item/new", "/api/restaurant/new", "/api/restaurant/update"],
        express.json({ limit: "10mb" }), …);
app.use(express.json({ limit: "1mb" }), …);
```

Order matters: scoped parsers must be registered **before** the global one or the global
1 MB limit rejects the image payload first. Only the base64 legacy paths get headroom.

### Consumers

`config/consumers.ts` contains all three handlers. See [08 Events](./08-events.md) for the
saga. Highlights:

- `onPaymentSuccess` → `markOrderPaid` (conditional, idempotent) → **clear the cart
  before notifying anyone**, so any cart refetch triggered by the sockets below sees an
  empty cart → emit `order:new` to the restaurant room, dual-emit `order:new` to the
  owner's `user:{id}` room, and `order:update` to the customer.
- `onRiderOrderAccepted` → `assignRider`. **If the claim fails it publishes
  `rider.order_rejected` and logs `[COMPENSATE]`** — this is the saga compensation that
  frees the rider.
- `onRiderStatusChanged` → `transitionRiderStatus(orderId, riderId)`. Only `picked_up`
  and `delivered` emit; `delivered` also publishes `order.delivered` so the rider service
  frees the rider.
- `onPaymentIntentCreated` → `stampPaymentIntent`. Failure logs
  `[ALERT][RECONCILE] <orderId>: order not stampable (paid/cancelled/expired)`.
- Unknown events are **acked and dropped** (not ours).

### `SNS envelope unwrapping`

Fan-out messages arrive inside the SNS notification wrapper, so both consumers use:

```ts
const body  = JSON.parse(record.body);
const inner = body.TopicArn ? JSON.parse(body.Message) : body;
```

This handles both raw-SQS work items and SNS-wrapped events with one function.

### Notable
- `getMyRestaurant` returns a **re-signed 7-day JWT** with a nested `{ user: {…, restaurantId} }`
  payload the first time, for legacy clients. The shared `isAuth` unwraps that nested
  shape — this is exactly why the shim exists.
- `getMyRestaurant` marks the response `private, max-age=5`.
- Public catalog reads set `s-maxage` so CloudFront absorbs them.
- `claimOrderForPaymentController` is the legacy internal endpoint, guarded by
  `x-internal-key` (compared against `INTERNAL_SERVICE_KEY`), returns **409** for an
  unclaimable order.
- `cancelOrderController` allows the order owner *or* the restaurant owner; it rejects
  `delivered` and `picked_up` in code **and** in the conditional update.

---

## 3. rider-service — `foodo-rider`

`backend/rider-service/` · Lambdas: `http`, `orderReadyConsumer`, `riderEventsConsumer`
· 512 MB / 15 s (consumers 30 s)

```
src/index.ts                   cookieSession + 10 MB parser on /api/rider/new
src/routes/rider.ts            router.use(isAuth, isRider)  ← whole surface protected
src/controller/rider.ts        all 8 handlers
src/controller/upload.ts       rider KYC upload signature
src/config/events.ts           domain publisher + SQS work item
src/config/consumers.ts        order-ready matcher + compensation handler
src/handlers/{orderReadyConsumer,riderEventsConsumer}.ts
```

### The entire `/api/rider/{proxy+}` surface is gateway-protected

Because `router.use(isAuth, isRider)` covers everything — **including rider
registration**. That is current app semantics, preserved and called out in the stack
comment: you must be an authenticated user whose role is `rider` to *become* a rider.
(`/health/rider` is the only public route.)

### `POST /accept/:orderId` — the most careful handler in the codebase

```ts
// 1. Atomic LOCAL claim — the only synchronous work
const rider = await claimRiderForOrder(userId, orderId);
if (!rider) return 404 "Rider not found or not available";

// 2. Publish — with rollback on failure
const published = await publishRiderEvent("rider.order_accepted", {
  orderId, riderId: rider.id, riderUserId: rider.userId,
  riderName: req.user.name ?? "Delivery Partner",
  riderPhone: rider.phoneNumber, riderPicture: rider.picture,
});

if (!published) {
  // Only flips back if this claim still owns the rider
  await releaseRiderFromOrder(rider.id, orderId, { orderId: null, status: "cancelled" });
  return 503 "Could not reach order service — try again";
}
return 200 "Order accepted";
```

Why rollback matters: if the event never reaches the bus, **nothing compensates** — the
restaurant never learns of the claim and the rider is stranded offline forever. So the
claim is undone in-place. Flipping availability first is what makes double-clicks
impossible at the rider level, and `currentOrderId` makes every later release conditional.

### `PUT /order/update` — publish the intent, don't apply it

Riders are on flaky mobile networks, so the rider service never mutates the order. It
publishes `rider.order_status_changed { orderId, riderId }` and returns **202 Accepted**
("Order status update queued"). The order owner applies the transition. On publish
failure it returns **503** so the app can retry, and it deliberately does **not** roll
back — nothing was rejected; the delivery is still real.

### `PATCH /toggle` — three guards

```ts
if (typeof isAvailable !== "boolean") 400
if (lat/lon missing)                   400
if (isAvailable && !rider.isVerified)  400 "Rider is not verified"
if (isAvailable) {
  try { if (await findCurrentOrderForRider(rider.id))
        return 400 "Finish your active delivery before going online" }
  catch { return 503 "Could not verify your delivery status. Try again." }
}
```

Note the `503` on lookup failure — it is **fail-closed**: better to refuse the toggle
than to let a rider carrying a delivery go offline.

### `GET /order/available` — the $near + $in replacement

```ts
const nearby = await listRestaurantsNear(lat, lon, 10_000);   // bounding box + haversine
const ids    = new Set(nearby.map(r => r.id));
const ready  = await listReadyOrders(200);                    // status-board GSI
return ready.filter(o => ids.has(o.restaurantId));
```

`listReadyOrders` uses `ScanIndexForward: true` (oldest first) — fairness, so the earliest
waiting order is offered first.

### Notable
- `createRiderController` requires `phoneNumber`, `addharNumber`,
  `drivingLicenseNumber`, `latitude`, `longitude` — all mandatory; a rider with no
  document cannot register. Duplicate user → 400 "Rider already exists".
- Image: prefers `body.imageUrl` (direct Cloudinary upload), falls back to multipart
  `req.file` → `dataUri` → `uploadToCloudinary`.
- `fetchMyDeliveryHistory` uses `listDeliveredOrdersByRider` (rider-orders GSI, filtered
  to `delivered` + `paid`) — powers both the Earnings and History pages.

---

## 4. admin-service — `foodo-admin`

`backend/admin-service/` · Lambda: `http` only · 512 MB / 15 s

```
src/index.ts             cookieSession + 1 MB JSON, mounts /api/admin
src/routes/admin.ts      router.use(isAuth) then router.use(isAdmin)
src/controllers/admin.ts 8 handlers
```

### The only service with `dynamodb:Scan`

Because `getPlatformStats` reads the entire orders table to compute revenue. Explicitly
documented in the controller header as the one unbounded read, with the fix named:
**DynamoDB Streams → a counter table**.

### Error handling is different here

Uses `tryCatchStatus` instead of `tryCatch`, so a thrown `HttpError` keeps its real
status:

```ts
class HttpError extends Error { status: number; … }
// 400 "Invalid id", 404 "Restaurant not found"
```

Every response is scrubbed:
```ts
stripCredentials  → removes password           (users)
stripKeys         → removes pk / sk            (restaurants, riders)
```

### Verification writes

`PATCH /verify/restaurant/:id` and `/verify/rider/:id` → `setRestaurantVerified(id, true)`
/ `setRiderVerified(id, true)`. There is only an approve path — no "unverify" endpoint
exists.

---

## 5. utils-service — `foodo-utils`

`backend/utils-service/` · Lambdas: `http`, `reconcile` (EventBridge `rate(1 hour)`)
· 512 MB / 15 s (reconcile 256 MB / 120 s)

```
src/index.ts               raw() webhook parser FIRST, then 1 MB JSON
src/routers/payment.ts     2 webhooks + 2 create endpoints
src/routers/cloudinary.ts  the 410 Gone tombstone
src/controllers/payment.ts Razorpay + Stripe create and webhook handlers
src/config/{razorpay,stripe}.ts
src/config/events.ts       publishPaymentSuccess (SQS) + publishPaymentIntentCreated (SNS)
src/config/webhookDedupe.ts
src/config/reconciliation.ts
src/config/rate-limit.ts
src/config/frontend.ts     origin resolution
src/config/http.ts         runProvider() circuit-breaker wrapper
src/handlers/{http,reconciliation}.ts
```

### The entire `/api/utils/{proxy+}` surface is public at the gateway

By design: **webhooks authenticate by provider HMAC signature over raw bytes, not by user
session.** The payment-create endpoints validate order state atomically in-controller
instead.

### Body-parser ordering is load-bearing

```ts
// 1) Webhooks: raw bytes only — must be BEFORE any JSON parser
app.use("/api/utils/payment/webhooks", express.raw({ type: "application/json" }));
// 2) [REMOVED] the 15 MB upload parser
// 3) Global 1 MB
app.use(express.json({ limit: "1mb" }));
```

If `express.json` ran first, the body would be parsed and the signature could never
verify. The 50 MB global limit was removed as trivial DoS amplification.

Full payment detail in [10 Payments](./10-payments.md).

### The 410 tombstone

`POST /api/utils/upload` returns **410 Gone** with a pointer to the `/upload-signature`
flow. Kept so stale deployments fail loudly instead of silently proxying bytes.

### `getFrontendOrigin(req)`

Resolution order: `Origin` header → `x-forwarded-host` + `x-forwarded-proto` → `Host`
header (with localhost/127.0.0.1 → http) → `FRONTEND_URL` → `http://localhost:3000`.
Used to build Stripe's `success_url` / `cancel_url`.

### `runProvider(fn, timeoutMs?)`

An `opossum` circuit breaker around provider SDK calls, with `opossum` still in the
dependency catalog. A provider outage opens the breaker instead of burning Lambda
duration on repeated timeouts.

---

## 6. realtime-service — `foodo-realtime`

`backend/realtime-service/` · Lambdas: `wsRouter` (256 MB / 10 s), `eventConsumer`
· 30 s timeout

```
src/handlers/wsRouter.ts       one Lambda behind $connect / $disconnect / $default
src/handlers/eventConsumer.ts  SNS → SQS → broadcast
src/config/websocket.ts         handleConnect / handleDisconnect / handleDefault
src/config/broadcaster.ts       Management API PostToConnection + Gone cleanup
src/config/db.ts                connection registry
```

Full detail in [09 Realtime](./09-realtime.md). Summary:

- `$connect` verifies the JWT from `?token=`, `Sec-WebSocket-Protocol`, or
  `Authorization`, and auto-joins `user:{id}` (and `restaurant:{id}` when
  `userData.restaurantId` exists).
- `$disconnect` removes every room row for the connection.
- `$default` routes three client actions.
- `eventConsumer` consumes **every** event on the topic — no filter policy, same as the
  old fanout exchange — and broadcasts to the `room` field if present.
- Owns its `ConnectionsTable` (TTL 24 h) and the WebSocket API itself, so it does not
  depend on `core` — a real asymmetry with every other service.

---

## 7. packages/types — `@foodo/types`

Zero-dependency, shared by **both** the web app and the services. That "both" is the
whole point: it prevents the order-status union from drifting between the server and the
client.

```ts
export type UserRole      = "customer" | "seller" | "rider" | "admin";
export interface AccessClaims { sub: string; role: string; typ: "access"; iat?, exp? }
export type OrderStatus   = "placed" | "accepted" | "preparing" | "ready_for_rider"
                         | "rider_assigned" | "picked_up" | "delivered" | "cancelled";
export type PaymentMethod = "razorpay" | "stripe" | "cod";
export type PaymentStatus = "pending" | "paid" | "failed";
```

The web app re-exports all of these from `apps/web/src/types/index.ts` so existing
`@/types` imports keep working unchanged.

---

## 8. packages/backend-common — shared Node-only utilities

**Rule 1: never import from `apps/web` or anything browser-targeted.** Nothing here may
end up in a browser bundle. **Rule 2:** Node runtime deps (`jsonwebtoken`, `multer`,
`express`) are `peerDependencies` so the consuming service controls the version.
**Rule 3:** only genuinely identical code lives here — auth-service's strict `isAuth` is
intentionally absent.

### Subpath exports

| Subpath | Contents |
|---|---|
| `@foodo/backend-common` | `isAuth` (permissive), `isSeller`, `isRider`, `isAdmin`, `tryCatch`, `tryCatchStatus`, `uploadFile`, `createCloudinaryUploadSignature` |
| `@foodo/backend-common/dynamo` | `Order`, `Restaurant`, `Rider`, `User` repositories + types |
| `@foodo/backend-common/aws` | `docClient`, `TABLE`, `makeFanoutPublisher`, `makeDomainEventPublisher`, `sendWorkItem`, `handleSqsBatch`, geo helpers, cache helpers, `deliveryDistanceKm` |
| `@foodo/backend-common/cloudinary` | `uploadToCloudinary` (server-side multipart fallback) |
| `@foodo/backend-common/files` | `dataUri` parser |

### Middleware

- **`tryCatch`** → any thrown error becomes `500 { message }`. Used by restaurant, rider,
  auth, utils. (Note: most of those controllers throw `Error("Unauthorized")`, which
  surfaces as a **500**, not a 401 — a real inconsistency, see
  [14 Known Gaps](./14-known-gaps.md).)
- **`tryCatchStatus`** → preserves a thrown `error.status` in `[400, 600)`, else 500.
  admin-service only.
- **`uploadFile`** → `multer` memory storage, `.single("file")`, scoped to the image
  create/update paths only.

### AWS helpers

`docClient()` is a lazily-created singleton per warm container — creating a client per
request is called out in the source as *the #1 Lambda performance mistake*.
`TABLE` resolves names from env with dev fallbacks
(`USERS_TABLE ?? "foodo-users"`, etc.), which also makes DynamoDB Local / moto work via
`AWS_DYNAMO_ENDPOINT`.

### Geo helpers

`haversineKm`, `deliveryDistanceKm`, `boundingBox`, `distanceMeters`. See
[04 §11](./04-data-model.md).

### Cache helpers

`setCacheablePublic`, `setCacheablePrivate`, `setNoCache`. See [02 §6](./02-architecture.md).

### Cloudinary signing

`createCloudinaryUploadSignature({ folder, tags?, transformation?, publicId?, extraParams? })`
implements Cloudinary's spec exactly: drop empty/reserved values → serialize (arrays
comma-joined) → **sort keys byte-wise** → join `key=value&…` → append the API secret →
SHA-1 → hex.

The returned payload **never contains the secret** — only `{ signature, timestamp, apiKey,
cloudName, folder, publicId?, tags?, transformation? }`. The signature is valid only for
that exact parameter set, so a client cannot escalate to another folder.

The secret is read from `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` /
`CLOUDINARY_API_SECRET` — note these are **not** the `CLOUDINARY_URL` shorthand that the
restaurant/rider stacks still pass in their environment blocks.