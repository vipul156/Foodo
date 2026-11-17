# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One product, four roles that share only the identity system and the order entity:

- **Customers** — browse verified open restaurants, build a cart, save delivery addresses, pay, track the rider live.
- **Sellers** — run one restaurant: menu, order transitions, revenue analytics.
- **Riders** — KYC onboarding, go online, take nearby ready orders, advance to delivered, stream GPS.
- **Admins** — verify restaurants and riders, read platform-wide stats.

## Product Purpose

Foodo is a multi-role food-delivery platform: a customer orders from a restaurant, a seller kitchen prepares it, a rider delivers it, and an admin keeps the marketplace verified. Success is an order that moves from `placed` to `delivered` without a manual refresh anywhere in the product.

## Positioning

Money and dispatch are server-authoritative. The client sends only `{ addressId, paymentMethod }`; distance, fees, rider payout, and assignment are computed server-side, and a payment becomes `paid` **only** through a signed provider webhook — never a client call. Claims about price or status in the UI must always trace back to a server response.

## Operating Context

Used on phones by customers ordering under time pressure, on kitchen tablets by sellers during service, and on phones by riders in motion. Customers pay in INR through Razorpay, Stripe, or cash on delivery. Live order state arrives over a WebSocket, and the frontend invalidates its query cache on every order event.

## Capabilities and Constraints

- A cart holds exactly one restaurant; adding from a second is rejected by the server.
- Fee rules: `deliveryFee = 49` when `subtotal < 250`, else `0`; `platformFee = 7`.
- Order statuses: `placed → accepted → preparing → ready_for_rider → rider_assigned → picked_up → delivered`, plus `cancelled` (never from `picked_up` or `delivered`).
- AI surfaces already implemented server-side: photo enhancement (Cloudinary URL transforms), packing verification and proof of delivery (advisory verdicts), conversational commerce (`/api/commerce/*`), menu photo parsing (`/api/menu-parser/*`), dispute arbitration (`/api/agent/*`), and dispatch orchestration.
- Conversational commerce drafts against the same menu and cart contracts but **never places an order**; the customer confirms explicitly and pays through the existing checkout.
- Out of scope today: push notifications, multi-restaurant carts, driver route optimisation or surge pricing, reviews, ratings, coupons, user-to-user chat.

## Brand Commitments

The name is **Foodo**. Voice is plain, direct, second person, no hype and no exclamation marks.

## Evidence on Hand

- `docs/` — the authoritative architecture set (`01-overview.md` through `14-known-gaps.md`) and the AI design documents.
- Real demo seeds: `auth-service/src/seed`, `restaurant-service/src/seed`, `rider-service/src/seed`.
- No testimonials, benchmark numbers, customer logos, or press exist. Future work must not fabricate them.

## Product Principles

1. Never show a number the server did not compute.
2. The order, not the interface, is the artifact; every screen advances it or explains it.
3. The customer's last action is always explicit and reversible up to the point of payment.
4. Real-time truth beats a refresh: state arrives, it is not re-polled by hand.
5. A failure names the problem and the recovery, in the customer's language.

## Accessibility & Inclusion

Keyboard focus is visible globally (`:focus-visible` in `globals.css`), motion respects `prefers-reduced-motion`, and the customer flows are mobile-first. WCAG AA is the working target (inference, not a formally stated commitment).
