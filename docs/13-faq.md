# 13 — FAQ / Interview Q&A

Grouped by theme. Answers are grounded in the code; file paths are given so you can verify.

---

## Architecture

**Q. How many services are there?**
Six backend services (`auth`, `restaurant`, `rider`, `admin`, `utils`, `realtime`) plus two
foundation stacks (`infra`, `core`) and one Next.js frontend. Nine deployable units.

**Q. Why one API Gateway instead of one per service?**
`core/serverless.yml` creates a single HTTP API and every service stack *attaches routes to
it by id*. One URL for the browser, one CORS posture (none), one authorizer, one access-log
stream. Service stacks cannot extend the API's CORS config — which is only a problem when
you need CORS at all, and you don't, because everything is same-origin through CloudFront.

**Q. What is the deploy order and why does it matter?**
`infra → core → services → frontend`. Service stacks read
`${cf:foodo-infra-<stage>.*}` and `${cf:foodo-core-api-<stage>.*}` CloudFormation exports.
No export, no resolve, no deploy. Teardown is the exact reverse.

**Q. How do services talk to each other?**
Four mechanisms only: (1) shared DynamoDB tables — the consistency point, (2) one SNS topic
with per-consumer filter policies, (3) two shared SQS work queues, (4) WebSockets. One
legacy HTTP endpoint survives (`/api/order/payment/claim`) but nothing calls it.

**Q. Why is there no Redis?**
Edge caching replaced it. Public catalog GETs carry `Cache-Control: s-maxage` and
CloudFront serves them. Personalized responses are `private`. See
`packages/backend-common/src/aws/cache.ts`.

**Q. Why is the VPC there but empty?**
Provisioned so a future private workload has a network. Nothing runs in it today, so NAT
gateways are parameterised to `0` (~$32/month each).

**Q. What runs in the VPC?**
Nothing. Every Lambda runs outside it. Gateway endpoints for S3 and DynamoDB exist for when
that changes.

**Q. What's the difference between infra and core?**
`infra` = network + data + events + identity (VPC, S3, Cognito, 8 DynamoDB tables, SNS
topic, 2 SQS queues). `core` = shared compute (the HTTP API and the JWT authorizer Lambda).

**Q. Why does realtime-service not attach to the core API?**
Because a WebSocket API is a different API Gateway resource type
(`AWS::ApiGatewayV2::Api` with `ProtocolType: WEBSOCKET`). It owns its own API, its stage,
its routes and its exports. It is the only service with no `coreApi` key in `custom`.

**Q. Is it really microservices if they share a database?**
Yes — the services own distinct aggregates (restaurants/menu/cart/addresses, riders, users,
admin, payments) and communicate by events for cross-aggregate flows. But the shared-orders
table is a deliberate trade: DynamoDB *is* the consistency point, which removes every
cross-Lambda read hop. The cost is that "which service owns the orders row" is a
convention, not an enforcement.

---

## Data

**Q. Why DynamoDB over MongoDB?**
The platform moved wholesale to AWS serverless primitives. Mongo's `$near`, `$facet`,
`populate`, embedded-array TTL and session-with-transaction features each needed a
hand-written replacement — bounding-box + haversine, in-Lambda rollups, batched `GetItem`,
per-row TTL items, `TransactWriteItems`. All of those replacements are documented in the
repositories.

**Q. What is the key schema?**
Every table is `pk` (HASH) + `sk` (RANGE), entity type encoded in `pk`:
`USER#<id>`, `ORDER#<id>`, `MENU#<id>`, `CART#<userId>`. Two exceptions: `webhook-dedupe`
uses `eventId` alone; the realtime connections table uses `connectionId` + `room`.

**Q. How many GSIs does the orders table have?**
Five: `user-orders`, `restaurant-orders`, `rider-orders`, `status-board`,
`payment-status`. Each answers exactly one query shape, all keyed on `createdAt` except
`payment-status` which uses `paymentIntentInitiatedAt`.

**Q. Why is `paymentIntentInitiatedAt` duplicated at the top level?**
A GSI cannot reach into a nested map. `stampPaymentIntent` mirrors it so reconciliation can
run `paymentStatus = pending AND paymentIntentInitiatedAt <= cutoff` as an index query
instead of a table scan.

**Q. How does `payment-status` work?**
`PK = paymentStatus`, `SK = paymentIntentInitiatedAt`. The reconciliation cron queries
`paymentStatus = "pending"` and a range on the sort key, bounded to 100 rows.

**Q. How are refresh tokens stored?**
As their own items under `USER#<id>` / `REFRESH#<sha256(token)>` with a TTL attribute, not
an embedded array. That gives per-row TTL (DynamoDB sweeps them), per-row revocation via one
`UpdateItem`, and no 400 KB item growth.

**Q. How is email lookup done?**
The `email-index` GSI on `email` (lowercased on write). Uniqueness is not enforced by the
GSI — `createUser` does a query-then-conditional-put guard. At this scale that is enough;
the source notes the race window is irrelevant.

**Q. How do you do geo queries without a geo index?**
`boundingBox()` computes a lat/lon box from the radius (`latDelta = r/111.32`,
`lonDelta = r/(111.32·cos lat)`), which prefilters candidates, then an exact haversine pass
sorts the survivors in Lambda. Used for riders within 10 km and restaurants within 50 km.

**Q. What is the coordinate order?**
Stored GeoJSON points are `[longitude, latitude]`. But `restaurantLocation` and
`deliveryAddress` on the order use named `{ latitude, longitude }` fields — the controller
swaps explicitly. This inconsistency is real; know it before touching distance code.

**Q. How is the cart modelled?**
One partition per user: `pk = CART#<userId>`, `sk = ITEM#<itemId>`. A `Query` returns the
whole cart. One restaurant per cart is enforced by scanning the partition for a row with a
different `restaurantId`.

**Q. How does `incrementCartItem` work?**
`ADD` and `SET` cannot share an `UpdateExpression`, so it branches: first insert uses
`PutCommand` with `attribute_not_exists(pk)`; repeat adds use `ADD quantity :one`. A lost
insert race is tolerated and the row is re-read.

**Q. How is pagination done?**
Keyset, not offset. Cursor is `"<createdAt>|<id>"`, the query asks for `limit + 1` rows to
detect "more" without a count query, and `ExclusiveStartKey` is built from the **index** key
attributes. `ScanIndexForward: false` for newest first. Server caps: default 50, max 200.

**Q. What are the conditional writes doing?**
They are the entire concurrency story — there is no locking. `markOrderPaid` requires
`paymentStatus <> paid`; `assignRider` requires `riderId = null AND status = ready_for_rider
AND paymentStatus = paid`; `transitionRiderStatus` requires the exact expected status;
`cancelOrder` requires neither `delivered` nor `picked_up`. A `null` return means "someone
else won" and the caller compensates.

**Q. Where is `TransactWriteItems` used?**
Exactly once: `createOrder`, to commit the order and (for COD) the cart clear together. It
is the `session.withTransaction` equivalent.

**Q. Which table can grow without bound?**
Orders. `admin-service`'s `/stats` runs a full `ScanCommand` on it. The documented fix is
DynamoDB Streams → a counter table. See [14](./14-known-gaps.md).

---

## Authentication

**Q. How does auth work?**
Two tokens. A 15-minute minimal-claims JWT (`sub` + `role` + `typ: "access"`) in a
`cookie-session` `session` cookie, plus a 30-day **opaque** refresh token in its own
`httpOnly` cookie scoped to `path=/api/auth`.

**Q. Why is the access JWT minimal?**
Every byte in a cookie is transport cost and tamper surface. Name/email/profile change, so
they come from `/me`. `sub` + `role` is all the guards need. No PII in the token payload.

**Q. Why 15 minutes?**
A JWT cannot be revoked. 15 minutes bounds the damage window after a leak. `ACCESS_TTL_SEC`
is defined once in `lib/tokens.ts`.

**Q. Why is the refresh token opaque instead of a JWT?**
So it *can* be revoked. A JWT refresh token would be unrevocable, which defeats the point of
having two tokens.

**Q. What is refresh-token reuse detection?**
Refresh tokens are single-use. On refresh the presented row is revoked and linked to the
next generation via `replacedByHash`. If an **already-revoked** token is presented again,
that is theft, and `revokeAllActiveRefreshTokens(userId)` burns **every** active session of
that user. Both the thief and the legitimate user are logged out. Recovery is cheap; a
silent attacker is not.

**Q. Does logout really log out?**
Yes — it revokes the presented refresh row server-side, then clears both cookies. The
**access JWT survives until natural expiry** (≤ 15 min). That is the documented cost of
stateless verification.

**Q. Where is JWT verification done?**
At the API Gateway, in `core/src/authorizer.ts`, before any service Lambda is invoked. The
shared `isAuth` only *reconstructs* `req.user` — it prefers the gateway-verified claims from
`requestContext.authorizer.lambda`, and falls back to `jwt.decode` of the session cookie
(decode ≠ verify; safe because the gateway already verified it).

**Q. How does the authorizer find the token?**
In order: the `session` cookie (base64-decoded, `.jwt`), then `Authorization: Bearer`.
The comment explains the reasoning: the inner JWT, not the cookie signature, is the
cryptographic boundary.

**Q. Why two different `isAuth` implementations?**
`auth-service` ships a **strict** one that rejects anything without `typ === "access"` — this
is how legacy full-user tokens are refused there. The shared one in `@foodo/backend-common`
is **permissive**, accepts any valid token across generations, and is used by
restaurant/rider/admin/utils. Merging them would break one of the two behaviours.

**Q. What are the role guards and what is odd about them?**
`isSeller` / `isRider` / `isAdmin`. The oddity, preserved verbatim from the original
per-service code: `isSeller` and `isAdmin` let an **unauthenticated** request through when
`req.user` is unset (falsy guard) — only a *present* user with the wrong role is rejected.
`isRider` is the inverse. The gateway authorizer already rejects anonymous traffic, so it
is unreachable in practice; it is preserved for behavioural parity.

**Q. How are brute-force logins prevented?**
Two layers, both in-memory per warm container: a per-IP flood limiter (20 / 5 min) and a
**failure-only** per-IP+email counter (10 failures / 15 min). The second layer is the
interesting one: an attacker with many IPs still burns the targeted account's budget, and a
legitimate user's successful logins never count against them. A 60 s `unref()`ed sweep keeps
the map bounded.

**Q. Can I self-register as admin?**
No. `allowedRoles = ["customer", "rider", "seller"]`; `admin` is rejected with
`400 "Invalid role"`.

**Q. Why is the socket token fetched separately?**
The WebSocket API is a different gateway, so cookies do not apply. Previously the token came
in the login body and lived in `sessionStorage` — reachable by any XSS. Now
`GET /api/auth/socket-token` returns a 15-minute token authenticated by the session cookie,
and the browser keeps it **in a module-level variable only**.

**Q. Does the authorizer cache its result?**
No — `AuthorizerResultTtlInSeconds: 0`. Caching a decision derived from a full Cookie header
risks both stale denials and missing-identity-source failures. A 128 MB `jwt.verify` is
cheap enough per request.

**Q. Is Cognito used?**
No. A user pool and SPA client are provisioned in `infra` and exported, but the app issues
its own `JWT_SECRET` tokens. Migration means flipping the authorizer to JWKS — nothing else
changes.

---

## Events

**Q. What is the event bus?**
One SNS topic, `foodo-infra-<stage>-events`. Every consumer declares its own SQS queue and
subscription with a `FilterPolicy` on the `event` message attribute. Adding a consumer never
touches a publisher.

**Q. What are the two envelopes?**
`{ event, room, payload }` for fanout (fire-and-forget, errors swallowed) and
`{ event, payload }` for domain events (returns `true`/`false` so the caller can
compensate). Plus `{ type, data }` for SQS work items.

**Q. Why does fanout swallow errors?**
Because a lost realtime event costs one stale UI panel. A lost domain event costs a rider
stranded offline. Different consequences, different policies.

**Q. List every event.**
`order:new`, `order:update`, `order:rider_assigned`, `order:delivered`, `order:available`,
`rider:location` (fanout); `rider.order_accepted`, `rider.order_status_changed`,
`payment.intent.created`, `rider.order_rejected`, `order.cancelled`, `order.delivered`
(domain); `order:ready_for_rider`, `PAYMENT_SUCCESS` (SQS work items).

**Q. How is idempotency achieved on SQS?**
SQS is at-least-once, so every handler is written to be safely re-runnable — and the safety
comes from **conditional DynamoDB updates**, not from a dedupe store. `markOrderPaid` needs
`paymentStatus <> paid`; `assignRider` needs `riderId = null`; `transitionRiderStatus` needs
the exact expected status.

**Q. Describe the rider-accept saga.**
The rider flips itself offline with a conditional local claim, then publishes
`rider.order_accepted`. If the publish fails it **rolls back locally** and returns 503 — no
compensation exists downstream, so stranding the rider would be permanent. Restaurant-service
consumes the event and runs `assignRider`. If the order is already taken or expired, it
publishes `rider.order_rejected` and rider-service frees the rider. Every path ends with the
rider available again.

**Q. Why doesn't the rider service update the order directly?**
Riders are on flaky mobile networks. It publishes the intent and returns **202**; the order
owner applies the transition. On publish failure it returns 503 so the app retries, and it
deliberately does **not** roll back — nothing was rejected, the delivery is still real.

**Q. What are the compensation events?**
`rider.order_rejected` (order was taken), `order.cancelled` (seller/customer cancelled an
assigned order), `order.delivered` (rider is free). All three route to
`rider.order_rejected`-style handling in `rider-service/src/config/consumers.ts`.

**Q. How does the rider matching work?**
Seller sets `ready_for_rider` → `sendWorkItem(orderQueue, "order:ready_for_rider", {orderId,
restaurantId, location})` → `rider-service` finds available riders within 10 km → broadcasts
`order:available` to each rider's `user:{id}` room. `listReadyOrders` uses
`ScanIndexForward: true` (oldest first) so the earliest waiting order is offered first.

**Q. What is `[COMPENSATE]` in the logs?**
`[COMPENSATE] order <id> not assignable — rider <id> release requested` — the
`assignRider` conditional update matched nothing, so `rider.order_rejected` was published.

**Q. What happens when a consumer throws?**
`handleSqsBatch` collects the message ids and returns `batchItemFailures`, so only failed
records redrive. After `maxReceiveCount: 3` the message lands in the queue's DLQ (14-day
retention).

---

## Payments

**Q. How does payment work?**
`POST /api/utils/payment/create` atomically claims the order and creates a provider intent
using the **server-side** amount. The provider then calls a webhook. Only that webhook marks
the order paid.

**Q. Why is there no client verify endpoint?**
A browser can lie about a payment. An HMAC over the raw request body cannot. After the
gateway redirect the frontend **polls** `GET /api/order/:orderId/status` (read-only) until
the webhook lands — 2 s interval, stops the moment `paymentStatus === "paid"`, pauses when
the tab is not focused.

**Q. How is the webhook authenticated?**
HMAC over the **raw body**. `express.raw({ type: "application/json" })` is mounted for
`/api/utils/payment/webhooks` **before** any JSON parser. Razorpay compares with
`crypto.timingSafeEqual` after a length check; Stripe uses `stripe.webhooks.constructEvent`.

**Q. What is webhook deduplication?**
`isDuplicateEvent(eventId)` does a conditional `PutCommand` on a 24 h-TTL table. Success =
first sighting (process); `ConditionalCheckFailedException` = already seen (200 "Duplicate
event"); **any other error = fail open and process anyway**, because the downstream consumer
is idempotent and dropping a real payment is far worse.

**Q. What is reconciliation?**
An hourly EventBridge cron that queries `paymentStatus = pending` older than 20 minutes and
asks the **provider** for the truth. If Razorpay says `paid` or Stripe says
`payment_status === "paid"`, it re-publishes `PAYMENT_SUCCESS`. It also flags orphans
(`ORPHAN:` / `unexpected provider status` → `[ALERT][RECONCILE] … MANUAL INSPECTION
REQUIRED`). This is the safety net for a lost webhook.

**Q. Why is the whole `/api/utils` surface public at the gateway?**
Because webhooks authenticate by **provider HMAC over raw bytes, not by user session**. The
payment-create endpoints validate order state atomically in-controller instead of relying on
a session.

**Q. Can a client pay a different amount?**
No. `claimOrderForPayment` returns `order.totalAmount` from the database and that value is
what gets sent to the provider. The request body carries only `orderId`.

**Q. What if the user double-clicks "pay"?**
The claim is a conditional update. If a provider order is already attached, the endpoint
returns the **same** id. Stripe additionally uses `idempotencyKey: order_<id>` natively.

**Q. How does COD work?**
The order is written with `paymentStatus: "paid"` and `expiresAt: null`, and the cart clear
commits in the same `TransactWriteItems`. No payment window, no TTL, and the restaurant is
notified immediately.

**Q. What is the 15-minute payment window?**
Unpaid online orders carry a TTL attribute. `markOrderPaid` does `REMOVE expiresAt, ttl`, so
a **paid order can never be swept**. Abandoned unpaid orders vanish on their own.

**Q. Why does utils claim the order directly instead of calling restaurant-service?**
Because DynamoDB is the consistency point. An HTTP hop would add a failure mode for
nothing. The legacy endpoint `/api/order/payment/claim/{orderId}` still exists, guarded by
`x-internal-key`, but nothing calls it.

**Q. What is `runProvider`?**
An `opossum` circuit breaker around provider SDK calls, so an outage trips the breaker
instead of burning Lambda duration on repeated timeouts.

---

## Realtime

**Q. What is the realtime stack?**
API Gateway WebSockets + a Lambda for the routes + a Lambda for broadcasts, with a DynamoDB
connection registry. It replaced a Socket.IO server.

**Q. What is a room?**
A string. Three namespaces: `user:{userId}` (auto-joined on connect), `restaurant:{id}`
(auto-joined when the token carries `restaurantId`), and `order:{id}` (client action).

**Q. How does the socket authenticate?**
`?token=<jwt>`, `Sec-WebSocket-Protocol`, or `Authorization: Bearer`. `$connect` runs
`jwt.verify` and returns 401 on failure, which rejects the handshake before a
`connectionId` is registered.

**Q. What client actions exist?**
`order:track`, `order:untrack`, `rider:location`. `rider:location` is the only one that
broadcasts rather than mutating membership.

**Q. How does a rider stream GPS?**
`navigator.geolocation.watchPosition` with `enableHighAccuracy`, throttled client-side to
one ping per 5 s (stored in a ref so it survives re-renders), errors swallowed. The server
relays it into `order:{orderId}` where the customer's Leaflet map consumes it.

**Q. How does the client reconnect?**
Infinite retries with capped exponential backoff (500 ms × 2^n, max 5 s). On success it
resets the attempt counter and fires a synthetic `"connect"` event, which re-arms every
`useSocketEvent` listener. Reconnecting is safe because `$connect` re-joins the rooms.

**Q. How are dead connections cleaned up?**
Three paths: `$disconnect` removes all room rows for the connection; a `GoneException` (410)
during a broadcast deletes the row immediately; and a 24-hour TTL is the backstop.

**Q. Does the frontend trust socket payloads?**
No — and this is a deliberate design decision. `useRealtimeOrderSync` uses every order event
purely as a **cache-invalidation signal** and refetches from the HTTP API. The socket is a
signal, not a data source.

**Q. Can a user subscribe to someone else's order tracking?**
`order:track` has no authorization check in `wsRouter`. Anyone connected can join any
`order:{id}` room. The HTTP endpoints that serve the order data **do** verify ownership, so
this is a display-surface gap rather than a data breach — but it should be closed. See
[14](./14-known-gaps.md).

**Q. Why do sellers get every event twice?**
Because the `restaurant:{id}` room join depends on `restaurantId` being **in the JWT**, and
the modern minimal-claims token only carries `sub` + `role`. So every publisher also
dual-emits to `user:{ownerId}`. Correct, but redundant — see [14](./14-known-gaps.md).

---

## Frontend

**Q. What is the frontend stack?**
Next.js 16 App Router, React 19, Tailwind v4 + shadcn/ui, TanStack Query for server state,
Zustand for client state, native WebSocket, Leaflet.

**Q. How do cookies work in the browser?**
Everything is **relative** `/api/*` on the CloudFront hostname, which reverse-proxies to the
gateway. So the session cookie is first-party: no custom domain, no CORS, no `SameSite=None`.

**Q. How does 401 refresh work?**
`request()` catches a 401, calls `refreshSession()` — **single-flight**, so ten concurrent
401s produce one `POST /api/auth/refresh` — then replays the original request. A second 401
propagates. Refresh/login/register are exempt from the retry so it cannot recurse.

**Q. Why does the frontend store the user in localStorage?**
`zustand/persist` under `foodo-auth`, `partialize`d to `{ user, isAuthenticated }` only. It
is a UX cache for rendering, **not** the auth mechanism — the cookie is. That is why
`useAuthHydrated()` exists: without it the app renders "logged out" for a frame and can
redirect a logged-in user to `/login`.

**Q. How do images get uploaded?**
Signed direct upload. The browser fetches a signature from the owning service, POSTs the
file straight to Cloudinary, and passes the returned `secure_url` in the JSON create call.
Image bytes never touch a backend.

**Q. Why do some backend routes have a 10 MB body limit?**
Only the base64 legacy upload paths: `/api/menu-item/new`, `/api/restaurant/new`,
`/api/restaurant/update`, `/api/rider/new`. Scoped parsers must be registered **before** the
global 1 MB parser or the global limit rejects the payload first.

**Q. How does seller order pagination work in the UI?**
`useInfiniteQuery` with `getNextPageParam: (lastPage) => lastPage.nextCursor`. The server
caps the page size, so there is no client "limit" control — more history means following the
cursor.

**Q. Why is `NEXT_PUBLIC_API_URL` empty?**
So the app uses relative URLs and everything stays same-origin. Setting it to a real gateway
host would reintroduce CORS and third-party cookies.

---

## Operations

**Q. How do I run it locally?**
No docker-compose. Run the frontend against a **deployed** backend:
`API_GATEWAY_URL=<HttpApiUrl> pnpm dev` in `apps/web`. The dev rewrites keep cookies
first-party.

**Q. What is `serverless-prune-plugin` for?**
It keeps the **3** most recent artifact versions of every function, so rollback is one
version back and S3 storage stays bounded.

**Q. How do I find out why a request 401'd?**
The HTTP API access log includes `authorizerError`. If it is populated, the token was bad;
if not, it was a route problem.

**Q. What is the biggest production concern?**
`admin-service`'s `/stats` scans the entire orders table on every dashboard load. It works
while order volume is dashboard-sized, but it is the one unbounded read. Fix: DynamoDB
Streams → a counter table.

**Q. What is the most interesting design decision here?**
The event bus. RabbitMQ's fanout exchange + work queues maps cleanly onto SNS + SQS, but the
key move was moving each consumer's queue and filter policy **into its own stack**. The
previous wiring was mis-wired across two stacks; now a service owns exactly its own
subscription, and adding a consumer requires zero publisher changes.

**Q. What would you change first?**
1. Close the `order:track` authorization gap in `wsRouter`.
2. Fix the `getMyRestaurant` 7-day re-signed JWT — it defeats the 15-minute access TTL and
   is why the seller needs a socket dual-emit at all.
3. Make `tryCatch` map `Unauthorized` to 401 instead of 500.
4. Add API Gateway usage plans (currently the documented serverless rate-limiting gap).
5. Replace the admin stats scan with Streams counters.
6. Delete the root `README.md`, which still documents MongoDB / RabbitMQ / Socket.IO.

Full list in [14 Known Gaps](./14-known-gaps.md).