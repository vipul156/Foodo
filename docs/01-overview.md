# 01 — Overview

## 1. What Foodo is

Foodo is a multi-role food-delivery platform. One codebase serves four completely
different user experiences, and they share almost nothing except the identity system
and the order entity.

| Role | Where they work | What they do |
|---|---|---|
| **Customer** | `/`, `/restaurants`, `/restaurants/[id]`, `/checkout`, `/orders`, `/orders/[id]`, `/locations` | Browse verified + open restaurants, add menu items to a cart, save delivery addresses, place an order, pay (Razorpay / Stripe / COD), track the rider live |
| **Seller** | `/seller/*` — dashboard, orders, menu, analytics, settings | Register one restaurant, upload a cover image, manage a menu, accept/preparing/ready-for-rider transitions, see revenue analytics |
| **Rider** | `/rider/*` — dashboard, history, earnings, profile | Register with KYC, go online/offline, see nearby ready orders, accept one, advance picked_up → delivered, stream GPS |
| **Admin** | `/admin/*` — dashboard, restaurants, riders, users, analytics, settings | Verify restaurants and riders, read platform-wide stats and revenue |

Role is a field on the user record (`UserRole = customer | seller | rider | admin`),
carried in the access JWT and enforced by per-service middleware.

---

## 2. The core loop

1. **Customer** adds items to a cart. The cart is scoped to exactly **one restaurant**
   — adding from a second restaurant is rejected.
2. At checkout the customer picks a **saved address** and a **payment method**.
3. The server computes everything money-related (see §4) and writes the order with
   status `placed`, payment status `pending` (or `paid` for COD).
4. For online payment the browser is handed a provider intent. **Only a verified
   provider webhook can flip the order to paid.**
5. When paid, the restaurant is notified in real time (`order:new`), the cart is cleared.
6. Seller moves the order `accepted → preparing → ready_for_rider`.
7. On `ready_for_rider` the order goes to the shared order work queue; the rider service
   finds available riders within 10 km and broadcasts `order:available` to each.
8. A rider accepts. The restaurant service atomically assigns the rider; if the assignment
   loses a race it publishes `rider.order_rejected` and the rider is freed.
9. Rider advances `picked_up → delivered`. Each transition is an event, applied by the
   order owner (restaurant service), bound to *that* rider's id.
10. On `delivered`, `order.delivered` is published and the rider service frees the rider
    so they can go online again.

---

## 3. The order lifecycle

Eight statuses, defined once in `@foodo/types` and used by every service:

```
placed ──▶ accepted ──▶ preparing ──▶ ready_for_rider ──▶ rider_assigned
                                                                │
                                                                ▼
                                                            picked_up
                                                                │
                                                                ▼
                                                            delivered
```

`cancelled` is reachable from any status **except** `picked_up` and `delivered`
(the conditional update in `cancelOrder` enforces it, not just the controller).

Who may set what:

| Transition | Actor | Mechanism |
|---|---|---|
| `→ placed` | system | order create |
| `placed → accepted / preparing / ready_for_rider` | seller | `PUT /api/order/:orderId` (guarded: must be paid, must own the restaurant) |
| `ready_for_rider → rider_assigned` | system | rider accepts → event → conditional assign |
| `rider_assigned → picked_up` | rider | `PUT /api/rider/order/update` → event → guarded transition |
| `picked_up → delivered` | rider | same |
| `→ cancelled` | customer **or** seller | `PATCH /api/order/:orderId/cancel` |

---

## 4. How money is calculated (all server-side)

The client sends only `{ addressId, paymentMethod }`. `distance` is **never** accepted
from the request body because it sets the rider payout.

```
subtotal    = Σ (menuItem.price × cartRow.quantity)
deliveryFee = subtotal < 250 ? 49 : 0
platformFee = 7
totalAmount = subtotal + deliveryFee + platformFee

distance    = max(1, haversineKm(restaurant, address) × 1.3)   // 1.3 = road detour factor
riderAmount = ceil(distance) × 17
```

`deliveryDistanceKm` floors at 1 km so a sub-kilometre delivery never underpays the rider.

---

## 5. Payments

| Method | How it works |
|---|---|
| **COD** | Order is written already `paid` in the same DynamoDB transaction that clears the cart. Restaurant is notified immediately. |
| **Razorpay** | `POST /api/utils/payment/create` → provider order. Webhook `payment.captured` / `order.paid` is the only thing that marks it paid. |
| **Stripe** | `POST /api/utils/payment/stripe/create` → hosted Checkout Session with `metadata.orderId`. Webhook `checkout.session.completed` (with `payment_status === "paid"`) marks it paid. |

**There is deliberately no client-driven "verify" endpoint.** A browser can lie about a
payment; a signed provider webhook cannot. After the gateway redirect the frontend
*polls* `GET /api/order/:orderId/status` (read-only) until the webhook lands.

Unpaid online orders carry a 15-minute TTL. When payment succeeds the TTL attribute is
removed, so a paid order can never be swept. An hourly reconciliation Lambda re-publishes
payments that the provider captured but whose webhook was lost.

---

## 6. Real-time

The browser holds one WebSocket to API Gateway. On connect it presents a short-lived
bootstrap JWT; the server verifies it and auto-joins `user:{id}` (and `restaurant:{id}`
for owners). Domain events published to the SNS topic are relayed by the realtime
service to the matching room through the Management API.

Six server→client events: `order:new`, `order:update`, `order:rider_assigned`,
`order:delivered`, `order:available`, `rider:location`.

Three client→server actions: `order:track`, `order:untrack`, `rider:location`.

The frontend's global hook invalidates the TanStack Query cache on every order event, so
every mounted dashboard refetches automatically — there is no manual refresh anywhere.

---

## 7. Media

Images never transit a backend in the normal path. Each owning service exposes a
`/upload-signature` endpoint that returns a **local HMAC-SHA1 signature**; the browser
POSTs the file straight to Cloudinary and passes the returned `secure_url` back.

Folders are fixed server-side per resource (`foodo/restaurants`, `foodo/menu-items`,
`foodo/riders/kyc`) so a client can never sign an upload into another namespace.
A legacy multipart server-side path still exists for old clients. The utils-service
upload proxy now answers **410 Gone**.

---

## 8. Non-goals / out of scope today

- Push notifications (only in-app WebSocket push).
- Multi-item carts spanning restaurants (explicitly rejected).
- Driver-side route optimisation, batching, or surge pricing.
- Reviews, ratings, coupons, chat.
- Real AWS Cognito usage — a user pool is provisioned but the app still issues its own JWTs.
- Any use of the S3 uploads bucket — it exists and is exported, but nothing writes to it yet.