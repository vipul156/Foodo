# 07 — API Reference

Every route the platform declares. Base URL in production is **relative** — the browser
calls `/api/...` on the CloudFront hostname, which reverse-proxies to the API Gateway.

Legend — **Auth**: `public` = no gateway authorizer; `jwt` = gateway authorizer + `isAuth`;
`jwt+role` = additionally `isSeller` / `isRider` / `isAdmin`.

---

## 1. Quick lookup — every endpoint

| Method | Path | Auth | Service |
|---|---|---|---|
| POST | `/api/auth/register` | public | auth |
| POST | `/api/auth/login` | public | auth |
| POST | `/api/auth/refresh` | public | auth |
| POST | `/api/auth/logout` | jwt | auth |
| GET | `/api/auth/me` | jwt | auth |
| GET | `/api/auth/socket-token` | jwt | auth |
| GET | `/api/restaurant/all` | public | restaurant |
| GET | `/api/restaurant/nearby` | public | restaurant |
| GET | `/api/restaurant/{id}` | public | restaurant |
| GET | `/api/restaurant/my` | jwt+seller | restaurant |
| GET | `/api/restaurant/upload-signature` | jwt+seller | restaurant |
| POST | `/api/restaurant/new` | jwt+seller | restaurant |
| PUT | `/api/restaurant/update` | jwt+seller | restaurant |
| PUT | `/api/restaurant/status` | jwt+seller | restaurant |
| GET | `/api/menu-item/all/{id}` | public | restaurant |
| GET | `/api/menu-item/upload-signature` | jwt+seller | restaurant |
| POST | `/api/menu-item/new` | jwt+seller | restaurant |
| DELETE | `/api/menu-item/delete/{id}` | jwt+seller | restaurant |
| PUT | `/api/menu-item/toggle/{id}` | jwt+seller | restaurant |
| POST | `/api/cart/add` | jwt | restaurant |
| GET | `/api/cart/all` | jwt | restaurant |
| DELETE | `/api/cart/clear` | jwt | restaurant |
| PUT | `/api/cart/increase` | jwt | restaurant |
| PUT | `/api/cart/decrease` | jwt | restaurant |
| DELETE | `/api/cart/remove` | jwt | restaurant |
| POST | `/api/order/new` | jwt | restaurant |
| POST | `/api/order/payment/claim/{orderId}` | `x-internal-key` | restaurant |
| GET | `/api/order/order/{restaurantId}` | jwt+seller | restaurant |
| GET | `/api/order/analytics/{restaurantId}` | jwt+seller | restaurant |
| PUT | `/api/order/{orderId}` | jwt+seller | restaurant |
| GET | `/api/order/my` | jwt | restaurant |
| GET | `/api/order/{orderId}/status` | jwt | restaurant |
| GET | `/api/order/{orderId}` | jwt | restaurant |
| PATCH | `/api/order/{orderId}/cancel` | jwt | restaurant |
| POST | `/api/address/new` | jwt | restaurant |
| DELETE | `/api/address/{id}` | jwt | restaurant |
| GET | `/api/address/all` | jwt | restaurant |
| GET | `/api/rider/upload-signature` | jwt+rider | rider |
| POST | `/api/rider/new` | jwt+rider | rider |
| GET | `/api/rider/myprofile` | jwt+rider | rider |
| PATCH | `/api/rider/toggle` | jwt+rider | rider |
| POST | `/api/rider/accept/{orderId}` | jwt+rider | rider |
| GET | `/api/rider/order/available` | jwt+rider | rider |
| GET | `/api/rider/order/current` | jwt+rider | rider |
| GET | `/api/rider/order/history` | jwt+rider | rider |
| PUT | `/api/rider/order/update` | jwt+rider | rider |
| GET | `/api/admin/stats` | jwt+admin | admin |
| GET | `/api/admin/restaurant/pending` | jwt+admin | admin |
| GET | `/api/admin/restaurant/all` | jwt+admin | admin |
| GET | `/api/admin/rider/pending` | jwt+admin | admin |
| GET | `/api/admin/rider/all` | jwt+admin | admin |
| GET | `/api/admin/user/all` | jwt+admin | admin |
| PATCH | `/api/admin/verify/rider/{id}` | jwt+admin | admin |
| PATCH | `/api/admin/verify/restaurant/{id}` | jwt+admin | admin |
| POST | `/api/utils/payment/webhooks/razorpay` | public (HMAC) | utils |
| POST | `/api/utils/payment/webhooks/stripe` | public (HMAC) | utils |
| POST | `/api/utils/payment/create` | public | utils |
| POST | `/api/utils/payment/stripe/create` | public | utils |
| POST | `/api/utils/upload` | public | utils → **410 Gone** |
| GET | `/health/{auth,restaurant,rider,admin,utils}` | public | each |

---

## 2. Auth service

### `POST /api/auth/register`
Body `{ name, email, password, role, image? }`. `role` ∈ `customer | rider | seller`.
Rejects `admin`. 400 on existing email.
→ `201 { message: "User created successfully", user }`

### `POST /api/auth/login`
Body `{ email, password }`.
→ `200 { message: "User logged in successfully", user }`
Errors: `400 "User not found"`, `400 "Invalid password"`, `429` from the brute-force limiter.

### `POST /api/auth/refresh`
No body. Reads the `refresh_token` cookie (path `/api/auth`).
→ `200 { message: "Token refreshed", accessToken, user }`
401s: `"No refresh token; please log in again"`, `"Invalid refresh token; …"`,
`"Refresh token expired; …"`, `"Session revoked (token reuse detected); …"`.

### `POST /api/auth/logout` · `GET /api/auth/me` · `GET /api/auth/socket-token`
→ `200 { message: "Logged out successfully" }` ·
`200 { message: "User fetched successfully", user }` ·
`200 { message: "Socket token issued", token, expiresIn: 900 }`

`user` is always `{ _id, name, email, role, image }`. Credentials never leave the DB.

---

## 3. Restaurant service

### Public

**`GET /api/restaurant/all`** → `{ success, count, data }`. Verified restaurants.
Cache: `public, s-maxage=120, swr=600`.

**`GET /api/restaurant/nearby?longitude&latitude&maxDistance`**
Without coordinates it degrades to the full verified list.
→ `{ success, count, data }`. `maxDistance` default **50 000 m**. Cache `s-maxage=60`.

**`GET /api/restaurant/{id}`** → `{ success, data }` · 404 `"Restaurant not found"`.

**`GET /api/menu-item/all/{id}`** → `{ message, menuItems }`. Cache `s-maxage=60`.

### Signed upload signatures

**`GET /api/menu-item/upload-signature`** →
```json
{ signature, timestamp, apiKey, cloudName,
  folder: "foodo/menu-items", tags: ["foodo","menu-item"],
  transformation: "w_1200,h_1200,c_limit,q_auto" }
```

**`GET /api/restaurant/upload-signature`** →
`folder: "foodo/restaurants"`, `tags: ["foodo","restaurant"]`,
`transformation: "w_1600,c_limit,q_auto"`.

Then the client POSTs the file to
`https://api.cloudinary.com/v1_1/<cloudName>/image/upload` and passes the returned
`secure_url` back as `imageUrl`.

### Seller writes

**`POST /api/restaurant/new`** — body `{ name, description, latitude, longitude, formattedAddress, phone, imageUrl?, file? }`.
One restaurant per owner → `400 "You already have a restaurant"`.
→ `200 { message: "Restaurant added successfully", restaurant }`

**`PUT /api/restaurant/update`** — any of `name`, `description`, `phone`, `imageUrl`/`file`.
→ `200 { message: "Restaurant details updated successfully", restaurant }`

**`PUT /api/restaurant/status`** — body `{ status: boolean }`.
→ `200 { message: "Restaurant status updated successfully", restaurant }`

**`POST /api/menu-item/new`** — body `{ name, description, price, imageUrl }` (or multipart
`file`, field name `file`). `price` is required — `0` is falsy and therefore rejected.
→ `201 { message: "Menu item created successfully", menuItem }`

**`DELETE /api/menu-item/delete/{id}`** / **`PUT /api/menu-item/toggle/{id}`** — both verify
`restaurant.ownerId === user.id`, otherwise `404 "Restaurant not found"` (deliberately
404, not 403 — don't confirm existence).

### Cart — all under `router.use(isAuth)`

| Endpoint | Body | Notes |
|---|---|---|
| `POST /add` | `{ restaurantId, itemId }` | 400 if a row from another restaurant exists |
| `GET /all` | — | `{ success, cart, subtotal, cartLength }` |
| `DELETE /clear` | — | |
| `PUT /increase` | `{ itemId }` | 404 if not in cart |
| `PUT /decrease` | `{ itemId }` | at qty 1 the row is **deleted** instead |
| `DELETE /remove` | `{ itemId }` | |

`GET /all` returns rows where `itemId` is the **full menu item object** (batched
enrichment) and `restaurantId` is `{ _id }` — preserving the old `populate()` shape.

### Orders

**`POST /api/order/new`** — body `{ addressId, paymentMethod }`.
`distance` is **not** accepted. Validates: address exists, cart non-empty, restaurant
exists and `isOpen`. Computes all money server-side.
COD → `paymentStatus: "paid"` + cart cleared in the same `TransactWrite`.
→ `201 { message: "Order created successfully", orderId, amount }`

**`GET /api/order/order/{restaurantId}?limit&cursor`** — seller only; verifies
`restaurant.ownerId === user.id`. `limit` default 50, **capped at 200 server-side**.
→ `{ success, count, orders, nextCursor }` — `nextCursor` is `"<createdAt>|<id>"`.

**`GET /api/order/analytics/{restaurantId}?days=7|30`** — seller only.
→ `{ success, analytics: { window, windowRevenue, windowOrders, avgOrder, change,
prevRevenue, delivered, cancelled, completionRate, buckets[], weekdayTotals[7],
topItems[5] } }`

**`PUT /api/order/{orderId}`** — body `{ status }` where status ∈
`accepted | preparing | ready_for_rider`. Requires `paymentStatus === "paid"`.
On `ready_for_rider` also publishes `order:ready_for_rider` to the rider work queue.
→ `200 { message: "Order updated successfully", order }`

**`GET /api/order/my`** → `{ success, count, orders }` (paid only, newest first).

**`GET /api/order/{orderId}/status`** — owner only.
→ `{ success, orderId, paymentStatus, status, totalAmount }` — **read-only**, this endpoint
can never fulfill a payment.

**`GET /api/order/{orderId}`** — owner only; items enriched with menu images.
→ `{ success, order }`

**`PATCH /api/order/{orderId}/cancel`** — order owner **or** restaurant owner.
Rejects `delivered` and `picked_up`. If the order was `rider_assigned`, publishes
`order.cancelled` to release the rider.
→ `200 { success, message, order }`

**`POST /api/order/payment/claim/{orderId}`** — internal. Header
`x-internal-key` must equal `INTERNAL_SERVICE_KEY`, else `"Forbidden"`.
Body `{ provider: "razorpay" | "stripe" }`.
→ `200 { success, orderId, amount, currency: "INR", attachedProviderOrderId }`
→ `409 "Order not claimable (paid, cancelled, or expired)"`

### Addresses

| Endpoint | Body | Response |
|---|---|---|
| `POST /api/address/new` | `{ mobile, formatterAddress, latitude, longitude }` | `201 { success, message, data }` |
| `DELETE /api/address/{id}` | — | `200 { success, message }` |
| `GET /api/address/all` | — | `200 { success, data }` (newest first) |

---

## 4. Rider service — every route requires `isAuth` **and** `isRider`

**`GET /api/rider/upload-signature`** → `folder: "foodo/riders/kyc"`,
`tags: ["foodo","rider","kyc"]`, `transformation: "w_800,h_800,c_limit,q_auto"`.

**`POST /api/rider/new`** — body `{ phoneNumber, addharNumber, drivingLicenseNumber,
latitude, longitude, imageUrl }` (or multipart `file`). All fields required.
→ `201 { message: "Rider created successfully", rider }`

**`GET /api/rider/myprofile`** → `200 { message: "Rider found", rider }` · 404.

**`PATCH /api/rider/toggle`** — body `{ isAvailable, latitude, longitude }`.
400 if the type is wrong, if `isAvailable` is true while unverified, or if an active
delivery exists. **503** if the active-delivery lookup itself fails (fail-closed).
→ `200 { message: "Rider availablity toggled", rider }` (sic — typo preserved)

**`POST /api/rider/accept/{orderId}`** → `200 { message: "Order accepted" }`
`404 "Rider not found or not available"` · `503 "Could not reach order service — try again"`

**`GET /api/rider/order/available`** → `{ message, count, orders }` — paid
`ready_for_rider` orders at restaurants within 10 km.

**`GET /api/rider/order/current`** → `{ message, order }` — any status except `delivered`.

**`GET /api/rider/order/history`** → `{ message, count, orders }` — delivered + paid.

**`PUT /api/rider/order/update`** — body `{ orderId }`.
→ **`202`** `{ message: "Order status update queued", orderId }` — accepted, not applied.
`503` on publish failure.

---

## 5. Admin service — every route requires `isAuth` **and** `isAdmin`

| Endpoint | Response |
|---|---|
| `GET /stats` | `{ users{total,newThisMonth}, restaurants{total,verified,open,pending}, riders{total,verified,online,pending}, orders{total,delivered,cancelled,active}, revenue{total,thisMonth,monthChange}, daily[], topRestaurants[] }` |
| `GET /restaurant/pending` | `{ count, restaurants }` (`isVerified === false`) |
| `GET /restaurant/all` | `{ count, restaurants }` (open ones first) |
| `GET /rider/pending` | `{ count, riders }` |
| `GET /rider/all` | `{ count, riders }` (online first) |
| `GET /user/all?role=` | `{ count, users }` — `password` stripped, bounded to 500 |
| `PATCH /verify/rider/{id}` | `{ message, rider }` · 404 |
| `PATCH /verify/restaurant/{id}` | `{ message, restaurant }` · 404 |

`revenue.monthChange` is always `null`, and `revenue.thisMonth` falls back to `total`
when `monthRevenue` is 0.

---

## 6. Utils service — the whole surface is public at the gateway

**`POST /api/utils/payment/create`** — body `{ orderId }`.
Atomically claims the order; returns the **server-side** amount.
→ `200 { razorpayOrderId, key }` · `409 "Order not claimable (paid, cancelled, or expired)"`
Idempotent: a repeat call with an attached provider order returns the same id.

**`POST /api/utils/payment/stripe/create`** — body `{ orderId }`.
→ `200 { url }` (hosted Checkout URL) · `409`
Uses Stripe's `idempotencyKey: "order_<id>"`, so retries return the same session.

**`POST /api/utils/payment/webhooks/razorpay`** — header `x-razorpay-signature`,
`x-razorpay-event-id`. HMAC-SHA256 over the **raw body** with
`RAZORPAY_WEBHOOK_SECRET`, compared with `crypto.timingSafeEqual` after a length check.
Only `payment.captured` / `order.paid` are acted on.
→ `200 { message: "Webhook processed" | "Event ignored" | "Duplicate event" }`
`400 "Invalid signature"` · `400 "Cannot resolve orderId"` · `500` (triggers redelivery).

**`POST /api/utils/payment/webhooks/stripe`** — header `stripe-signature`, verified by
`stripe.webhooks.constructEvent` against raw bytes. Only
`checkout.session.completed` **with** `payment_status === "paid"`.
→ `200 { message: … | "Payment not settled" }` · `400 "Invalid webhook"`

**`POST /api/utils/upload`** → `410 Gone` with a pointer to the `/upload-signature` flow.

---

## 7. Health endpoints

`GET /health/{auth,restaurant,rider,admin,utils}` — all public, all returning
`{ status: "UP", timestamp }`. utils additionally reports `uptime`.

⚠️ These are gateway routes on a different path than the Lambda's internal `/health`
Express route. Because `/health/{name}` is declared on the shared HTTP API, the Lambda's
own `/health` is only reachable through the service's catch-all, which for several
services does not exist.

---

## 8. Error conventions

`tryCatch` (all services except admin) returns **500** with `{ message }` for any thrown
error — including `throw new Error("Unauthorized")`, so some authorization failures
surface as 500 rather than 401. `tryCatchStatus` (admin) preserves a thrown `error.status`.

Explicit `res.status(...)` responses are the reliable ones: 400 validation, 401 missing
credentials, 404 not found, 409 unclaimable order, 429 rate limited, 503 dependency down.

Client-side, everything non-2xx becomes an `ApiError` carrying `{ status, data }`, and a
401 triggers the refresh-and-retry path unless the URL is in `AUTH_RETRY_EXEMPT`.