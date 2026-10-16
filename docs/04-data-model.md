# 04 — Data Model

Everything lives in DynamoDB. There is no MongoDB, no Redis, no SQL. The old
mongoose models and RabbitMQ layers were removed when the platform moved to AWS; all
query logic now lives in `packages/backend-common/src/dynamo/*.ts` (shared repositories)
plus a few service-local repositories.

## Key design conventions

1. **Single-table-per-entity, `pk`/`sk` composite key.** Entity type is encoded in the
   partition key: `USER#<id>`, `ORDER#<id>`, `MENU#<id>`, `CART#<userId>`.
2. **No `$populate`.** References are plain string attributes; enrichment is done with
   **batched** `GetItem` calls and assembled in memory (`fetchMenuItemsForCart`).
3. **Conditional writes instead of transactions** wherever possible. `TransactWriteItems`
   is used only for the order-create + cart-clear pair.
4. **TTL for expiry.** No cron sweeps for sessions or unpaid orders.
5. **GeoJSON coordinate order is `[longitude, latitude]`** everywhere, matching Mongo
   2dsphere.

---

## 1. Users — `foodo-infra-<stage>-users`

| Key | Type |
|---|---|
| Partition key | `pk` (S) |
| Sort key | `sk` (S) |

Two item shapes share the table:

```
USER#<userId> / PROFILE                  → the user
USER#<userId> / REFRESH#<tokenHash>      → a refresh-token session row
```

### GSIs

| Index | PK | SK | Projection | Used by |
|---|---|---|---|---|
| `email-index` | `email` | — | ALL | login (`getUserByEmail`) |
| `refresh-index` | `tokenHash` | — | ALL | `getUserByRefreshTokenHash` |

### Profile item

```ts
interface DynamoUser {
  pk: "USER#<uuid>"; sk: "PROFILE";
  id: string; name: string;
  email: string;              // lowercased
  password: string;           // bcrypt hash — never leaves the service
  role: string;               // customer | seller | rider | admin
  image: string;
  createdAt: string; updatedAt: string;
}
```

### Refresh row

```ts
interface RefreshTokenRow {
  pk: "USER#<userId>"; sk: "REFRESH#<sha256(token)>";
  tokenHash: string;          // sha256 hex of the raw opaque token
  createdAt: string;
  expiresAt: string;          // ISO
  ttl: number;                // epoch seconds — DynamoDB sweeps automatically
  revokedAt: string | null;
  replacedByHash: string | null;  // links to the next generation (chain walk)
}
```

**Why rows instead of an embedded array** (the Mongo version): a growing array on one item
hits the 400 KB item limit, the old TTL had to be a `$pull` on access, and revoking a
single session meant rewriting the whole array. Rows give per-row TTL, per-row revocation
via one `UpdateItem`, and no unbounded growth.

`tokenHash` = `sha256(rawToken)` hex. Raw tokens are never stored.
`newRefreshTokenRaw()` = three concatenated UUIDs with dashes stripped → **96 hex chars**
of entropy.
`REFRESH_TTL_MS = 30 days`.

---

## 2. Restaurants — `foodo-infra-<stage>-restaurants`

| Key | Type |
|---|---|
| Partition key | `pk` (S) — `RESTAURANT#<id>` |
| Sort key | `sk` (S) — `META` |

| Index | PK | SK | Used by |
|---|---|---|---|
| `owner-index` | `ownerId` | — | `getRestaurantByOwner` — one restaurant per owner |
| `verified-index` | `isVerified` (N) | — | `listVerifiedRestaurants` (public catalog), `listPendingRestaurants` (admin) |

```ts
{
  id, ownerId, name, description, phone, image,
  isVerified: boolean,        // admin flips this
  isOpen: boolean,            // seller toggles this
  autoLocation: { type: "Point",
                  coordinates: [lng, lat],
                  formattedAddress: string },
  createdAt, updatedAt
}
```

`isVerified` is a **number** type in the index definition because it is used as a GSI
partition key; the stored item keeps it boolean.

---

## 3. Riders — `foodo-infra-<stage>-riders`

| Key | Type |
|---|---|
| Partition key | `pk` (S) — `RIDER#<id>` |
| Sort key | `sk` (S) — `META` |

| Index | PK | SK | Used by |
|---|---|---|---|
| `user-index` | `userId` | — | `getRiderByUserId` (one rider per user) |
| `verified-index` | `isVerified` (N) | — | `listPendingRiders`, `listAllRiders` |

```ts
{
  id, userId,
  picture: string,            // Cloudinary secure_url
  phoneNumber: string,
  addharNumber: string,       // KYC
  drivingLicenseNumber: string,
  isVerified: boolean,        // admin flips this
  isAvailable: boolean,       // rider toggles online/offline
  location: { type: "Point", coordinates: [lng, lat] },
  lastActive: string,
  createdAt, updatedAt
}
```

Plus runtime fields used by the claim/release saga (see §9): `currentOrderId`,
`currentOrderStatus`.

---

## 4. Orders — `foodo-infra-<stage>-orders`

The busiest table, the only one with five GSIs, PITR on, and per-item TTL.

| Key | Type |
|---|---|
| Partition key | `pk` (S) — `ORDER#<orderId>` |
| Sort key | `sk` (S) — `ORDER` |

### The five GSIs

| Index | PK | SK | Used by |
|---|---|---|---|
| `user-orders` | `userId` | `createdAt` | `GET /api/order/my` |
| `restaurant-orders` | `restaurantId` | `createdAt` | seller order board (keyset-paginated), seller analytics |
| `rider-orders` | `riderId` | `createdAt` | rider current order, delivery history, earnings |
| `status-board` | `status` | `createdAt` | `listReadyOrders` — the rider matching board |
| `payment-status` | `paymentStatus` | `paymentIntentInitiatedAt` | hourly reconciliation sweep |

> The `payment-status` GSI cannot reach into the nested `paymentIntent` map, so
> `paymentIntentInitiatedAt` is **mirrored at the top level** of the item and kept in
> sync by `stampPaymentIntent`.

### Item shape

```ts
{
  pk: "ORDER#<uuid>", sk: "ORDER", id,
  userId, restaurantId, restaurantName,
  restaurantLocation?: { latitude, longitude },   // [lat, lon] here — note the swap
  riderId: string | null,
  riderName: string | null, riderPhone: string | null, riderPicture: string | null,

  items: [{ itemId, name, price, quantity }],    // name/price snapshotted

  subtotal, deliveryFee, platformFee, totalAmount,   // computed server-side
  distance, riderAmount,                              // computed server-side

  addressId,
  deliveryAddress: { formattedAddress, mobile, latitude, longitude },

  status: OrderStatus,
  paymentMethod: "razorpay" | "stripe" | "cod",
  paymentStatus: "pending" | "paid" | "failed",

  paymentIntent?: { provider, providerOrderId?, initiatedAt? },
  paymentIntentInitiatedAt?: string,        // flat mirror for the GSI

  expiresAt?: string,   // ISO, unpaid only
  ttl?: number,         // epoch seconds — DynamoDB sweeps unpaid orders
  createdAt, updatedAt
}
```

**Two intentional inconsistencies worth knowing:**
- `autoLocation.coordinates` is `[lng, lat]` (GeoJSON), but `restaurantLocation` and
  `deliveryAddress` store named `{ latitude, longitude }` fields. The order controller
  swaps explicitly when building `restaurantLocation`.
- `markOrderPaid` does `REMOVE expiresAt, ttl`, so a **paid order can never be TTL-swept**.

### Order create is transactional

```
TransactWriteItems:
  [ Put   orders  (the new order),
    Delete carts  (Key: { pk: "CART#<userId>" })   ← only for COD ]
```

This is the `session.withTransaction` equivalent: a failed cart delete can no longer
orphan an order, or vice versa. For online payments the cart is cleared later by the
payment consumer (`clearCart`), deliberately **outside** the transaction so notifications
never run inside it.

Because all cart rows of one user share the partition key `CART#<userId>`, one `Delete`
clears the whole cart. (The non-transactional `clearCart` helper does a per-row delete
loop instead, because `TransactWriteItems` cannot delete an unknown number of rows.)

---

## 5. Menu items — `foodo-infra-<stage>-menu-items`

| Key | Type |
|---|---|
| Partition key | `pk` (S) — `MENU#<itemId>` |
| Sort key | `sk` (S) — `ITEM` (constant) |

| Index | PK | Used by |
|---|---|---|
| `restaurant-index` | `restaurantId` | `listMenuItemsByRestaurant` |

```ts
{ id, restaurantId, name, description, price,
  category?: string, image: string, isAvailable: boolean, createdAt, updatedAt }
```

Service-local repository (`backend/restaurant-service/src/dynamo/cart.ts`).

---

## 6. Carts — `foodo-infra-<stage>-carts`

| Key | Type |
|---|---|
| Partition key | `pk` (S) — `CART#<userId>` |
| Sort key | `sk` (S) — `ITEM#<itemId>` |

No GSIs. One partition per user; a `Query` on `pk` returns the whole cart.

```ts
{ pk, sk, userId, restaurantId, itemId, quantity, createdAt, updatedAt }
```

**"One restaurant per cart"** is enforced by `findCartFromDifferentRestaurant`: query the
partition, and if any row has a different `restaurantId`, reject the add with HTTP 400
`"You can only have one restaurant in your cart"`.

`incrementCartItem` cannot mix `ADD` and `SET` paths in one `UpdateExpression`, so it
branches: first insert uses `PutCommand` with
`ConditionExpression: "attribute_not_exists(pk)"` (a lost insert race is tolerated —
both writers meant "make sure this item is in the cart"), repeat adds use
`ADD quantity :one`.

---

## 7. Addresses — `foodo-infra-<stage>-addresses`

| Key | Type |
|---|---|
| Partition key | `pk` (S) — `USER#<userId>` |
| Sort key | `sk` (S) — `ADDRESS#<id>` |

No GSIs. `listAddresses` queries the partition with
`begins_with(sk, "ADDRESS#")` and `ScanIndexForward: false` (newest first).

```ts
{ pk, sk, id, userId, mobile,
  formatterAddress: string,              // note the field name typo, preserved from Mongo
  location: { type: "Point", coordinates: [lng, lat] },
  createdAt }
```

---

## 8. Webhook dedupe — `foodo-infra-<stage>-webhook-dedupe`

| Key | Type |
|---|---|
| Partition key | `eventId` (S) — the provider event id |

TTL attribute `ttl`, 24 h. No GSIs, no sort key.

```ts
{ eventId, seenAt: <epoch sec>, ttl: <epoch sec + 86400> }
```

`isDuplicateEvent(eventId)` does a `PutCommand` with
`ConditionExpression: "attribute_not_exists(eventId)"`:

- **Success** → first sighting, this caller claimed the marker, return `false`.
- **`ConditionalCheckFailedException`** → already seen, return `true` (duplicate).
- **Any other error** → the dedupe store is down. Returns `false` (process it) because the
  downstream consumer is idempotent; dropping a real payment would be far worse.

The old in-memory window only protected one process, which is useless across Lambda
containers — this is durable.

---

## 9. Realtime connections — owned by realtime-service

`foodo-realtime-<stage>-connections` — declared **in the realtime stack**, not infra,
because ephemeral runtime state belongs with the service that uses it.

| Key | Type |
|---|---|
| Partition key | `connectionId` (S) |
| Sort key | `room` (S) |

| Index | PK | Used by |
|---|---|---|
| `room-index` | `room` | `getConnectionsInRoom(room)` → all connection ids in a room |

```ts
{ connectionId, room, ttl: <epoch sec + 24h> }
```

`removeConnection` queries by `connectionId`, then `BatchWriteItem` deletes every row for
that connection (one connection can be in several rooms).

---

## 10. Conditional-write patterns (the concurrency story)

There is no locking anywhere. Every race is won by a DynamoDB `ConditionExpression`.

| Operation | Condition | Loser behaviour |
|---|---|---|
| `markOrderPaid` | `paymentStatus <> paid` | returns `null`, no-op — webhook redeliveries are free |
| `stampPaymentIntent` | `paymentStatus <> paid` | `null`; logs `[ALERT][RECONCILE]`, orphan intent gets flagged later |
| `claimOrderForPayment` | `attribute_exists(pk) AND paymentStatus <> paid AND status <> cancelled` | `null` → HTTP **409** "Order not claimable" |
| `assignRider` | `attribute_exists(pk) AND riderId = null AND status = ready_for_rider AND paymentStatus = paid` | `null` → publish `rider.order_rejected` to free the rider |
| `transitionRiderStatus` | `status = <exact expected status>` | `null` → stale/redelivered event no-ops |
| `setOrderStatus` | `attribute_exists(pk) AND paymentStatus = paid` | `null` → "Order not paid" |
| `cancelOrder` | `status <> delivered AND status <> picked_up` | `null` → "Order can no longer be cancelled" |
| `createMenuItem` (cart insert) | `attribute_not_exists(pk)` | tolerated, re-read |
| `isDuplicateEvent` | `attribute_not_exists(eventId)` | duplicate detected |

`isValidOrderId(id)` accepts either a UUID or a 24-char hex string. It exists so a stale
Mongo ObjectId **fails loudly at the boundary** instead of silently returning "not found",
which the payment saga would misread as "expired".

---

## 11. Geo queries without a geo index

DynamoDB has no 2dsphere index. The replacement is a two-phase query in
`packages/backend-common/src/aws/geo.ts`:

```ts
boundingBox(lat, lon, radiusKm)  // latDelta = r/111.32
                                // lonDelta = r/(111.32 * cos(lat))
// 1. prefilter candidates by indexed lat/lon numbers inside the box
// 2. exact haversine pass on the survivors, sort in Lambda memory
```

This is fine because every Foodo geo query is small and bounded:

| Query | Radius | Implementation |
|---|---|---|
| Nearby restaurants to a user | default 50 km | `listRestaurantsNear` |
| Riders near a restaurant | 10 km | `listAvailableRidersNear` |
| Delivery distance (payout) | n/a | `haversineKm × 1.3`, floored at 1 km |

`deliveryDistanceKm` duplicates `restaurant-service/src/lib/distance.ts` verbatim — the
service copy is legacy and the shared one is authoritative.

---

## 12. Pagination

`listOrdersByRestaurant` implements **keyset pagination**, not offset:

- Cursor wire format: `"<createdAt>|<id>"` — the id tiebreaker guarantees pages never
  overlap even when many orders share a timestamp.
- Query fetches `limit + 1` rows; the extra row detects "there is more" with **no
  separate count query**.
- `ExclusiveStartKey` is built from the **index** key attributes
  (`{ restaurantId, createdAt, id }`), not the table key.
- `ScanIndexForward: false` → newest first.
- Server caps: default 50, maximum 200, clamped server-side regardless of what the client asks.

The frontend consumes it with `useInfiniteQuery` +
`getNextPageParam: (lastPage) => lastPage.nextCursor`. Deep pages cost the same as page 1.

---

## 13. Aggregations and the scan trade-off

DynamoDB has no `$facet`. Two places compute aggregates in Lambda instead:

**Seller analytics** (`GET /api/order/analytics/:restaurantId`) — one bounded query
(`limit: 500`) on `restaurant-orders`, filtered to paid and non-cancelled orders created
since the previous window start, then rolled up in memory into daily buckets, weekday
totals, top-5 items by revenue, window revenue, and period-over-period change. Sized for
dashboard traffic; a restaurant's 60-day volume is a few hundred rows.

**Platform stats** (`GET /api/admin/stats`) — a `ScanCommand` over the **whole orders
table**, plus bounded reads of restaurants, riders and users, rolled into totals, a
30-day daily revenue series, and top-5 restaurants by revenue. This is explicitly
flagged in the source as the one place that grows without bound, with the documented fix:
move revenue rollups to **DynamoDB Streams → a counter table**.