# 14 — Known Gaps & Risks

An honest register of what is incomplete, fragile, or dead in this codebase. Every item
below is verifiable in the source.

---

## 1. Security

### 1.1 `order:track` has no authorization check — **medium**

`backend/realtime-service/src/config/websocket.ts`, `handleDefault`:

```ts
case "order:track":
  if (message.orderId) await joinRoom(connectionId, `order:${message.orderId}`);
  break;
```

Any connected client can join **any** `order:{orderId}` room and therefore receive that
order's `rider:location` broadcasts (the rider's live GPS, every 5 s).

Blast radius today is limited: the HTTP endpoints that serve order data
(`GET /api/order/:orderId`, `/:orderId/status`) **do** verify `order.userId === user._id`.
So this leaks live delivery coordinates, not order contents or customer details.

**Fix:** in `order:track`, verify ownership before joining — read the order from the
`orders` table (`getOrderById`) and check `order.userId === token sub` (riders: check
`order.riderId === riderId`; sellers: check `restaurant.ownerId === sub`). The realtime
service would need `dynamodb:GetItem` on the orders table, which it does not currently have
in its IAM role.

### 1.2 The seller socket room join is effectively dead — **medium**

`handleConnect` only joins `restaurant:{restaurantId}` when
`userData.restaurantId` exists in the token. The modern access JWT carries only
`{ sub, role, typ }` — no `restaurantId`. So in practice:

- Sellers receive order events through the **`user:{ownerId}`** dual-emit, which every
  publisher performs alongside the `restaurant:{...}` emit.
- The `restaurant:{id}` room has essentially no subscribers.

Not a security issue — it is correct-but-redundant traffic. It became necessary because of
§2.1.

**Fix (paired):** put `restaurantId` in the socket bootstrap token issued by
`GET /api/auth/socket-token`, then delete the `user:{ownerId}` dual-emits.

### 1.3 `getMyRestaurant` issues a 7-day JWT — **medium**

`backend/restaurant-service/src/controllers/restaurant.ts`:

```ts
if (!user.restaurantId) {
  const token = jwt.sign({ user: { ...user, restaurantId: restaurant.id } } as any,
                          JWT_SECRET, { expiresIn: "7d" });
  return res.status(200).json({ message: "…", restaurant, token });
}
```

Three problems:
1. **7 days vs 15 minutes** for the access token — a 672× larger exposure window.
2. The nested `{ user: { … } }` shape is a legacy Mongo-era artifact.
3. It exists only for old clients; nothing in the current frontend consumes `token`.

It also forces the `decoded.user || decoded` unwrap in the WebSocket `$connect` and the
nested-payload shim in the shared `isAuth`.

**Fix:** delete the token entirely once legacy clients are gone, then remove both shims.

### 1.4 API Gateway throttling is not declared — **medium**

`backend/utils-service/src/config/rate-limit.ts` states the position explicitly:

> *the shared external counter would be the only correct store — and that now belongs at the
> edge, not in app code.*

That edge enforcement point does not exist in `core/serverless.yml`. All rate limiting is
therefore **per warm Lambda container** and resets on cold start, so the effective limits
are weaker than the configured numbers.

**Fix:** add `AWS::ApiGatewayV2::Stage` throttling (`DefaultRouteSettings.ThrottlingBurstLimit`
/ `RateLimit`) or a usage plan.

### 1.5 JWT verification of the legacy 7-day token happens only in services — **low**

The gateway authorizer will accept that token too, since it is signed with the same secret
and has a valid `sub`. Nothing distinguishes it from a 15-minute access token at the edge.

Resolved automatically when §1.3 is fixed.

---

## 2. Correctness

### 2.1 `tryCatch` returns 500 for authorization failures — **medium**

`packages/backend-common/src/middlewares/trycatch.ts` maps **every** thrown error to 500.
Many controllers do `throw new Error("Unauthorized")`, so those responses are **500, not
401**:

- `createOrder`, `fetchRestaurantOrders`, `getRestaurantAnalytics`, `updateOrderStatus`,
  `cancelOrderController`, `getMyOrders`, `getOrderPaymentStatus`, `fetchSingleOrder` in
  restaurant-service.
- Cart and address controllers mostly use `res.status(401)` explicitly — inconsistent
  within the *same* codebase.

Effect: the frontend cannot distinguish "not logged in" from "server broke", and the
automatic refresh-and-retry only triggers on a real 401 — so these paths will **not**
attempt a token refresh.

**Fix:** either add a `status` property to those throws and switch those services to
`tryCatchStatus`, or add a message→status map in `tryCatch`.

### 2.2 Cart increment is not concurrency-safe — **low**

`incrementCartItem` does a `GET` then either `Put` (with
`attribute_not_exists(pk)`) or `ADD quantity :one`. The comment acknowledges this:

> *The GET check keeps double-adds from concurrent tabs correct enough for a cart.*

Two tabs adding the same new item concurrently can lose one increment. Acceptable for a
cart; it is not acceptable for anything that moves money.

### 2.3 The admin stats scan is unbounded — **medium at volume**

`getPlatformStats` runs `new ScanCommand({ TableName: TABLE.orders() })` on every dashboard
load. The source flags it and names the fix (DynamoDB Streams → counter table). Fine while
orders are dashboard-sized; a production incident at 10⁵+ orders.

### 2.4 Cart clear inside `TransactWriteItems` uses a single-key `Delete` — **low**

`createOrder` deletes `{ pk: "CART#<userId>" }` with no sort key. That is only correct because
every cart row shares that partition key **and** the table's sort key is effectively
constant per item. It works today; it is subtle, and the non-transactional `clearCart`
helper does a per-row loop instead — two different mechanisms for the same operation.

### 2.5 Reconciliation is capped at 100 candidates per run — **low**

`fetchCandidates` uses `Limit: 100`. With more than 100 stale pending payments in an hour,
the overflow waits for the next run. Acceptable; worth a log line if it ever saturates.

### 2.6 Reconnect has no jitter — **low**

`scheduleReconnect` uses `min(500 × 2^n, 5000)` with no randomisation. A service restart
brings every client back on the same cadence — a mild thundering herd on the realtime Lambda.

---

## 3. Dead code & drift

### 3.1 The root `README.md` is two architectures out of date — **high (documentation)**

It documents **MongoDB, RabbitMQ, and Socket.IO**. The platform is DynamoDB + SNS/SQS +
API Gateway WebSockets. Anyone onboarding from it will be misled about every persistence,
messaging and realtime detail.

The `docs/` directory now supersedes it. **Delete or rewrite it.**

### 3.2 The legacy 7-day JWT — see §1.3.

### 3.3 `POST /api/order/payment/claim/{orderId}` is unreachable in practice — **low**

Nothing calls it; utils-service claims directly against the shared table. It is still
declared, still public at the gateway, and still guarded by `x-internal-key`.

### 3.4 `POST /api/utils/upload` is a 410 tombstone — **low (intentional)**

Deliberate: stale deployments should fail loudly rather than silently proxy bytes. Keep it
for one release, then delete along with `INTERNAL_SERVICE_KEY`.

### 3.5 `cloudinaryRouter`'s legacy multipart path — **low (intentional)**

`uploadToCloudinary` in `@foodo/backend-common/cloudinary` and the `dataUri` parser still
support the base64 flow, which is why the 10 MB body limits exist. Removal also means
dropping the 10 MB scoped parsers.

### 3.6 `packages/backend-common/src/cloudinary/upload.ts` — **low**

A one-line re-export file separate from `cloudinary.ts`. Harmless, but there are two files
named `cloudinary*` in the package which is mildly confusing.

### 3.7 `Restaurant.ts` / `Rider.ts` geo queries use a bounding box + haversine — **(not a gap)**

Documented as an intentional replacement for Mongo `$near`. Called out here only so nobody
"fixes" it into a scan.

### 3.8 Unused `listReadyOrders` import in admin-service — **cosmetic**

```ts
// listReadyOrders is imported for future admin tooling (live order board)
void listReadyOrders;
```

Explicitly suppressed to avoid a lint error. Remove the import.

### 3.9 `distance.ts` duplicated in restaurant-service — **cosmetic**

`backend/restaurant-service/src/lib/distance.ts` is a verbatim copy of the shared
`deliveryDistanceKm` in `packages/backend-common/src/aws/geo.ts`. The shared one is
authoritative; delete the local copy.

### 3.10 S3 uploads bucket, Cognito user pool, VPC — provisioned, unused — **low**

All three exist with exports and nothing consumes them:
- `foodo-infra-<stage>-uploads` — images go to Cloudinary.
- Cognito pool + client — the app issues its own JWTs.
- VPC + subnets + gateway endpoints — no workload runs in it; NAT stays at 0 because of this.

Keeping them is a deliberate forward-looking choice, but each carries a small carrying cost
and adds confusion. Decide: adopt or delete.

### 3.11 Cognito password policy vs the app's own — **low**

The pool requires min 8 with upper + lower + number. `auth-service` enforces **no** password
policy at all — `bcrypt.hash(password, 10)` on whatever arrives.

---

## 4. Configuration inconsistencies

### 4.1 `CLOUDINARY_URL` vs the three separate variables — **high (breaks image upload)**

`backend/restaurant-service/serverless.yml` and `rider-service/serverless.yml` both declare:

```yaml
CLOUDINARY_URL: ${env:CLOUDINARY_URL, ''}
```

But `packages/backend-common/src/cloudinary.ts` reads:

```ts
CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
```

and throws `"Cloudinary credentials missing: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY
and CLOUDINARY_API_SECRET"` if any is absent. So setting only `CLOUDINARY_URL` gives you a
**500 on every `/upload-signature` call**.

**Fix:** replace `CLOUDINARY_URL` with the three variables in restaurant, rider and utils.

### 4.2 `infra/README.md` still describes the API as having CORS — **low (documentation)**

`infra/README.md` describes `foodo-core-api` as *"Shared HTTP API (single base URL + CORS)"*.
`core/serverless.yml` has **no** `CorsConfiguration`, by design — all traffic is
same-origin through CloudFront. Anyone following that README will add CORS headers or try a
cross-origin integration that the architecture specifically avoids.

The root `README.md` (§3.1) is worse — it documents an entirely different persistence and
messaging stack. Both should be replaced by a pointer to `docs/`.

### 4.3 `INTERNAL_SERVICE_KEY` is declared only on restaurant-service — **low**

`backend/restaurant-service/serverless.yml` injects `INTERNAL_SERVICE_KEY`; no other stack
declares it. That is currently correct, because only
`POST /api/order/payment/claim/{orderId}` checks the header and only restaurant-service
hosts it. Worth a comment in the YAML so nobody adds a second internal caller and assumes
the variable already exists.

### 4.4 Health routes — `/health/{name}` vs the Express `/health` — **low**

Every service declares `GET /health/{name}` on the shared HTTP API and every service also
defines an Express `app.get("/health")`. Those are **different paths**. The Express `/health`
is only reachable if a catch-all forwards it; for auth, restaurant, rider, admin and utils
there is no such route on `/api/*`. The Lambda-level `/health` is effectively unreachable
through the gateway.

**Fix:** decide whether `/health/{name}` or `/health` is canonical and drop the other.

---

## 5. Scale & operations

### 5.1 `listOrdersByUser` has a `FilterExpression` on the GSI — **low**

```ts
IndexName: "user-orders",
KeyConditionExpression: "userId = :u",
FilterExpression: "paymentStatus = :paid",   // ← post-filter, not part of the key
```

A filter is applied **after** the read, so it does not reduce RCUs but it *does* mean the
`Limit` counts pre-filter rows. With many unpaid orders a user could return fewer than
`limit` results even though more paid ones exist deeper in the index.

**Fix:** add `paymentStatus` to the GSI key, or paginate until enough rows survive.

The same pattern exists in `listOrdersByRestaurant` and `listDeliveredOrdersByRider`.

### 5.2 `listReadyOrders(200)` then filter in memory — **low**

The rider dashboard fetches up to 200 ready orders and filters to nearby restaurants in
Lambda. If ready orders exceed 200, a nearby one beyond the cap is invisible.

**Fix:** paginate the `status-board` GSI, or denormalise a geo attribute onto the order.

### 5.3 In-memory rate limiting — see §1.4.

### 5.4 No request tracing / structured logging — **medium**

Logs are plain `console.*` with hand-written prefixes. There is no request-id propagation
from the API Gateway access log into the Lambda logs, so correlating one user action across
`sst.config.ts` → API → service → SNS → consumer requires timestamp guessing.

**Fix:** enable `Lambda Insights` or inject `x-amzn-trace-id` and log it.

### 5.5 No automated tests — **medium**

`detected_test_files: 0`. The critical paths — the rider-claim saga, payment claim
idempotency, refresh rotation — are the hardest parts of the system and are entirely
unverified by CI.

**Highest-value first tests:** `claimOrderForPayment` idempotency,
`assignRider` single-winner, `markOrderPaid` redelivery no-op, refresh reuse detection,
`deliveryDistanceKm` flooring.

---

## 6. Prioritised fix list

| # | Item | Effort | Impact |
|---|---|---|---|
| 1 | §4.1 Cloudinary env var names | minutes | **breaks image upload outright** |
| 2 | §3.1 delete the stale README | minutes | misleading documentation |
| 3 | §2.1 `tryCatch` → real 401s | ~1 h | breaks automatic refresh on order/cart paths |
| 4 | §1.4 API Gateway throttling | ~2 h | the actual per-IP rate limit |
| 5 | §1.3 + §1.2 remove the 7-day JWT, add `restaurantId` to the socket token | ~half day | closes a 7-day token and removes the dual-emit |
| 6 | §1.1 authorize `order:track` | ~half day | closes live-GPS leakage |
| 7 | §5.5 first saga + payment tests | ~2 days | confidence in money and rider paths |
| 8 | §2.3 Streams counters for admin stats | ~1 day | removes the unbounded scan |
| 9 | §5.1 paid-only GSI keys | ~half day | correct pagination |
| 10 | §5.4 trace-id logging | ~half day | debuggability |
| 11 | §3.8–3.10 dead code cleanup | ~1 h | clarity |
| 12 | §4.4 health route duplication | minutes | clarity |