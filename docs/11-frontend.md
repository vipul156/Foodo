# 11 — Frontend

`apps/web` — Next.js 16.2.12, React 19.2.4, App Router, deployed via SST + OpenNext on
CloudFront.

```json
"dev": "next dev", "build": "next build", "start": "next start",
"lint": "eslint", "deploy": "sst deploy", "remove": "sst remove"
```

---

## 1. Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16.2.12, App Router, `output: "standalone"` |
| UI | React 19.2.4, Tailwind CSS v4, shadcn/ui, Radix, Base UI, CVA, `cn` merge |
| Icons | lucide-react, @hugeicons |
| Animation | framer-motion 12 |
| Server state | **TanStack Query v5** (React Query) |
| Client state | **Zustand v5** (3 stores, one persisted) |
| Forms | react-hook-form 7 + zod 4 + @hookform/resolvers |
| Realtime | **native WebSocket** (`src/lib/socket.ts`) — Socket.IO removed |
| Maps | Leaflet 1.9 + react-leaflet 5 |
| Toasts | shadcn toast (`components/ui/toaster.tsx`) |
| Deployment | SST 3 + OpenNext, CloudFront + arm64 Lambda |

---

## 2. Routing — four role groups

```
app/
├── layout.tsx                 root: QueryProvider + SocketProvider
├── _not-found/  _global-error/
├── (auth)/
│   ├── layout.tsx
│   ├── login/page.tsx
│   └── register/page.tsx
├── (customer)/
│   ├── layout.tsx             customer shell
│   ├── page.tsx               "/" — restaurant listing / landing
│   ├── restaurants/page.tsx   list + nearby
│   ├── restaurants/[id]/page.tsx   menu browsing, add to cart
│   ├── checkout/page.tsx      address selection, payment method, place order
│   ├── orders/page.tsx        order history
│   ├── orders/[id]/page.tsx   order detail + live tracking
│   ├── locations/page.tsx     saved address management
│   ├── payment/success/page.tsx   polls /api/order/:id/status
│   └── payment/cancel/page.tsx
├── seller/
│   ├── layout.tsx   page.tsx  orders/  menu/  analytics/  settings/
├── rider/
│   ├── layout.tsx   page.tsx  history/  earnings/  profile/
└── admin/
    ├── layout.tsx   page.tsx  restaurants/  riders/  users/  analytics/  settings/
```

Each group has its own `layout.tsx` shell (sidebar, mobile sidebar, role guard). Auth lives
outside them because it needs the opposite treatment.

Role gating is done by `components/shared/role-guard.tsx` plus each layout, reading the
persisted Zustand auth store.

---

## 3. API client — `src/lib/api-client.ts`

### The single-flight 401 → refresh → retry

```ts
request(url, config)
  └─ requestOnce(url, config)
       ├─ ok  → return data
       └─ 401 → exempt?  → throw
                 refreshSession()  // ONE in-flight POST /api/auth/refresh, shared
                 → requestOnce(url, config) again
```

`AUTH_RETRY_EXEMPT = ["/api/auth/refresh", "/api/auth/login", "/api/auth/register"]` —
retrying any of those could never help and would recurse.

```ts
let refreshInFlight: Promise<void> | null = null;
refreshSession() {
  if (!refreshInFlight)
    refreshInFlight = (async () => { await request("/api/auth/refresh", { method: "POST" }); })()
      .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
```

Ten concurrent 401s → **one** refresh call. The `httpOnly` refresh cookie does the work;
the response carries the fresh Set-Cookie headers.

### The socket bootstrap token

```ts
let socketToken: string | null = null;    // module scope = memory only
fetchSocketToken() → GET /api/auth/socket-token
getSocketToken()    → reuse
clearSocketToken()  → on logout
```

Never `sessionStorage`, never `localStorage`. Any XSS could read those; memory dies with
the page.

### Error type

```ts
class ApiError extends Error { status: number; data: unknown; }
```

Built from `error.response.data?.message || error.message || "Request failed"`.

### Service clients

```ts
authApi       → /api/auth*         (get, post)
restaurantApi → /api*              (get, post, put, patch, delete)  ← no prefix, full path
riderApi      → /api/rider*        (get, post, patch, put)
adminApi      → /api/admin*        (get, patch)
```

`restaurantApi` deliberately takes a **full path** (`/restaurant/all`, `/cart/all`,
`/order/new`) because restaurant-service owns five routers.

`useCreateRazorpayOrder` and `useCreateStripeSession` bypass `restaurantApi` and call
`axios.post("/api/utils/payment/create", …, { withCredentials: true })` directly, since
utils is a separate prefix.

---

## 4. `src/lib/api.ts` — SSR vs browser

```ts
buildClient({ req })
  ├─ server (typeof window === "undefined" && req)
  │    → baseURL "http://localhost:3000", headers = req.headers   ← cookies forwarded
  └─ browser
       → baseURL "", withCredentials: true                        ← relative, same-origin
```

On the server, incoming headers (including cookies) are forwarded so SSR calls keep the
session. In the browser, everything is relative so it goes through the same origin.

`getApiClient(req?)` memoises a single browser instance; server instances are per-request
(headers differ).

---

## 5. Next.js rewrites — dev only

```ts
async rewrites() {
  if (!isDev || !API_GATEWAY_URL) return [];
  return [{ source: "/api/:path*", destination: `${API_GATEWAY_URL}/api/:path*` }];
}
```

In production, requests hit CloudFront, which routes `api/*` to the gateway origin — so no
rewrite is needed and there is nothing to configure per service. In dev, the rewrite keeps
everything same-origin so the session cookie still works.

`turbopack.root` is pinned to the workspace root (`../..`) so `@foodo/*` packages resolve.

`images.remotePatterns` allows `**.amazonaws.com` and `res.cloudinary.com` only.

---

## 6. State — three Zustand stores

| Store | Persisted | Contents |
|---|---|---|
| `auth-store.ts` | ✅ `localStorage["foodo-auth"]` | `user`, `isAuthenticated`, `isLoading`; `setUser`, `setLoading`, `logout` |
| `socket-store.ts` | ❌ | `isConnected`, `lastEvent` |
| `ui-store.ts` | ❌ | `sidebarOpen`, `activeModal`, `globalLoading`, `userLocation` |

`partialize` limits persistence to `{ user, isAuthenticated }` — transient loading flags
are not written.

### Hydration guard

```ts
useAuthHydrated(): boolean
```

`zustand/persist` restores from `localStorage` asynchronously. Without this guard the app
would briefly render "logged out" and redirect a logged-in user to `/login`. `useAuthHydrated`
returns `false` until `persist.hasHydrated()` or `onFinishHydration` fires, and guards render
against that.

### The `_id` contract

`publicUser()` in auth-service returns `_id`, and `IUser.id` is what every component reads.
The web app never renames it — a deliberate preservation of the Mongo-era contract so no
component had to change.

---

## 7. Data fetching — TanStack Query hooks per feature

```
features/auth/api/         useLogin, useRegister, useCurrentUser, useLogout
features/restaurants/api/  restaurants, menu items, cart, addresses  (13 hooks)
features/orders/api/       create, payment create, payment status, my orders,
                           single order, restaurant orders (infinite),
                           seller analytics, cancel, update status
features/rider/api/        profile, toggle, available, current, accept,
                           update status, history, create
features/admin/api/        stats, pending/all restaurants, pending/all riders,
                           all users, verify restaurant, verify rider
```

Conventions:
- `staleTime` is tuned by cost: 5 min for `/me`, 1 min for analytics, 2 min for catalogs,
  30 min for rider history.
- Mutations invalidate the broadest sensible key (`["orders"]`, `["rider"]`, `["cart"]`,
  `["menu-items"]`, `["restaurant"]`).
- `refetchInterval` is used only where polling is genuinely needed — 2 s for payment status
  (stops the moment `paymentStatus === "paid"`), 15 s for rider available/current.

### Order status polling

```ts
useOrderPaymentStatus(orderId) {
  refetchInterval: (query) => query.state.data?.paymentStatus === "paid" ? false : 2000,
  refetchIntervalInBackground: false,
  staleTime: 0, retry: 1,
}
```

Polls every 2 s **only while the tab is focused** and stops the instant the webhook lands.

### Keyset pagination

```ts
useGetRestaurantOrders(restaurantId, limit = 50)  // useInfiniteQuery
  initialPageParam: null
  queryFn: ({ pageParam }) => restaurantApi.get(`/order/order/${restaurantId}`,
                 { params: { limit, ...(pageParam ? { cursor: pageParam } : {}) } })
  getNextPageParam: (lastPage) => lastPage.nextCursor
```

`useRestaurantOrdersFlat` flattens `data.pages` for components that just want a list. The
server caps every page, so there is no client "load more" knob — deep pages cost the same
as page 1.

---

## 8. Realtime integration

`providers/socket-provider.tsx` mounts at the root and connects/disconnects on auth
changes. `hooks/use-socket-event.ts` subscribes safely across every lifecycle hazard
(mount before connect, service restart, socket recreated on auth change) by depending on
`useSocketStore(s => s.isConnected)`.

`hooks/use-realtime-order-sync.ts` is the piece that makes the whole app feel live —
see [09 Realtime §8](./09-realtime.md).

### Live tracking

`features/tracking/components/live-tracking-map.tsx` renders the `order:{id}` room with
Leaflet. The customer sends `order:track` / `order:untrack`; the rider's
`use-rider-location-stream` sends `rider:location` every 5 s.

---

## 9. Direct image upload

```
1. GET /api/{menu-item,restaurant,rider}/upload-signature   → signed params
2. POST File → https://api.cloudinary.com/v1_1/<cloudName>/image/upload
3. POST the create/update endpoint with the returned secure_url as imageUrl
```

`src/lib/cloudinary-upload.ts` performs steps 1–2 from the browser. Every create/update
hook does this before its JSON mutation:

```ts
const sig  = await restaurantApi.get<CloudinaryUploadParams>("/menu-item/upload-signature");
const url  = await uploadToCloudinary(data.imageFile, sig);
await restaurantApi.post("/menu-item/new", { name, description, price, imageUrl: url });
```

**Image bytes never touch a backend.** A legacy base64/`file` path still exists server-side
for old clients, which is why the create/update routes have 10 MB body limits while
everything else is capped at 1 MB.

Folders are fixed server-side per resource, so a client cannot sign into someone else's
namespace.

---

## 10. Feature components

| Path | Purpose |
|---|---|
| `components/shared/glass-card.tsx` | the glassmorphism card used across dashboards |
| `components/shared/mobile-sidebar.tsx` | responsive navigation drawer |
| `components/shared/premium-button.tsx` | primary CTA |
| `components/shared/theme-toggle.tsx` | light/dark |
| `components/shared/role-guard.tsx` | role-based render gate |
| `components/ui/button.tsx`, `ui/toaster.tsx` | shadcn primitives |
| `features/cart/components/cart-sheet.tsx` | slide-over cart |
| `features/tracking/components/live-tracking-map.tsx` | Leaflet live map |

---

## 11. Root providers

```tsx
<QueryProvider>        // TanStack Query client (+ devtools in dev)
  <SocketProvider>     // connect on auth, disconnect on logout / unmount
    {children}
  </SocketProvider>
</QueryProvider>
```

`components.json` is present, confirming the shadcn CLI workflow is the source for
`components/ui`.

---

## 12. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | build | **empty string by design** — relative URLs, same-origin |
| `NEXT_PUBLIC_REALTIME_WS_URL` | build | `wss://…/dev`, discovered from the `foodo-realtime-<stage>-WebSocketUrl` export or set explicitly |
| `NEXT_PUBLIC_STAGE` | build | stage name, injected by SST |
| `API_GATEWAY_URL` | dev only | enables the `next.config.ts` rewrites proxy |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | server | signature signing |

⚠️ `NEXT_PUBLIC_*` variables are **inlined at build time**. Changing the WebSocket URL
requires a rebuild + redeploy of the frontend, not just a restart.