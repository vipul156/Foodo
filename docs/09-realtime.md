# 09 — Realtime

The realtime tier replaced a Socket.IO server. It is now **API Gateway WebSockets +
Lambda**, with a DynamoDB connection registry.

Stack: `foodo-realtime` · `backend/realtime-service/`

| Resource | Type | Notes |
|---|---|---|
| `WebSocketApi` | `AWS::ApiGatewayV2::Api` | `ProtocolType: WEBSOCKET`, `RouteSelectionExpression: "$request.body.action"` |
| `WebSocketStage` | `AWS::ApiGatewayV2::Stage` | `AutoDeploy: true` |
| `WsRouterIntegration` | `AWS::ApiGatewayV2::Integration` | `AWS_PROXY` |
| `WsConnectRoute` / `WsDisconnectRoute` / `WsDefaultRoute` | `AWS::ApiGatewayV2::Route` | `$connect`, `$disconnect`, `$default` |
| `ConnectionsTable` | `AWS::DynamoDB::Table` | PK `connectionId`, SK `room`, TTL 24 h, GSI `room-index` |
| `RealtimeQueue` | `AWS::SQS::Queue` | `foodo-realtime-<stage>-emit`, `VisibilityTimeout: 120`, no DLQ |
| `RealtimeSubscription` | `AWS::SNS::Subscription` | **no FilterPolicy** — receives everything |

**One Lambda serves all three routes** (`wsRouter`, 256 MB / 10 s). The stated reason: one
function keeps the connection registry warm across a client's whole
connect → messages → disconnect lifecycle.

Exports: `WebSocketApiId`, `WebSocketUrl`
(`wss://<apiId>.execute-api.<region>.amazonaws.com/<stage>`).

⚠️ This is the **only** service that does not attach to the shared `core` HTTP API. It owns
its own API Gateway, which is why it has no `coreApi` key in `custom`.

---

## 1. The room model

A *room* is a string. Three namespaces:

| Room | Joined by | Receives |
|---|---|---|
| `user:{userId}` | **automatically** on connect | everything addressed to that user |
| `restaurant:{restaurantId}` | automatically on connect, if the token carries `restaurantId` | everything addressed to that restaurant |
| `order:{orderId}` | **client action** `order:track` | live rider GPS for that order |

The `user:` and `restaurant:` joins happen server-side during `$connect`, so a client never
has to ask for them. This is why a seller's dashboard works the moment the socket opens.

---

## 2. `$connect` — handshake authentication

```ts
const token =
  event.queryStringParameters?.token ||
  event.headers?.["Sec-WebSocket-Protocol"] ||
  event.headers?.["Authorization"];

if (!token) return fail(401, "Unauthorized: missing token");

const cleanToken = token.replace(/^Bearer\s+/i, "");
const decoded = jwt.verify(cleanToken, JWT_SECRET);
const userData = decoded.user || decoded;         // ← unwraps the nested legacy shape
const userId = userData._id || userData.sub || userData.id;

if (!userId) return fail(401, "Invalid token payload");

await joinRoom(connectionId, `user:${userId}`);
if (userData.restaurantId) await joinRoom(connectionId, `restaurant:${userData.restaurantId}`);
return ok();   // 200
```

Three token sources are accepted for compatibility with different clients. The
`decoded.user || decoded` unwrap handles the 7-day nested JWT that
`GET /api/restaurant/my` issues.

Failing `$connect` with a non-2xx rejects the handshake — API Gateway closes the socket
and sends the status to the client. That is how an unauthenticated socket is stopped
before a `connectionId` is ever registered.

⚠️ Note the `restaurant:{id}` join depends on `restaurantId` being **in the token**. The
minimal access JWT only carries `{ sub, role }`. So the restaurant room join works only
for clients using the legacy 7-day token from `/restaurant/my` — for the normal
minimal-claims token, sellers rely on the **dual-emit to `user:{ownerId}`** that every
publisher also performs. See [14 Known Gaps](./14-known-gaps.md).

---

## 3. `$disconnect`

```ts
await removeConnection(connectionId);
return ok();
```

`removeConnection` queries `connectionId` across all rooms, then issues one
`BatchWriteItem` deleting every row. Necessary because one connection can be in `user:`,
`restaurant:` and several `order:` rooms.

---

## 4. `$default` — client actions

```ts
switch (message.action) {
  case "order:track":    joinRoom(connectionId, `order:${orderId}`);   break;
  case "order:untrack":  leaveRoom(connectionId, `order:${orderId}`);  break;
  case "rider:location":
    broadcastToRoom(endpoint, `order:${orderId}`, "rider:location",
                    { orderId, latitude, longitude, at: Date.now() });
    break;
  default: console.log(`Unknown action: ${message.action}`);
}
```

`rider:location` is the only action that **originates a broadcast** rather than mutating
room membership. The rider does not need to be in the `order:{id}` room to broadcast into
it — the customer's tracker just has to be.

Validation on the location action: `orderId` present **and** both coordinates are
`typeof "number"`. Anything else is silently ignored.

`order:track` / `order:untrack` are **not** authorization-checked — any connected client
can join any `order:{id}` room. Tracking is gated at the HTTP layer (the order detail
endpoint verifies ownership), so the socket is a display surface, not a data boundary.
See [14 Known Gaps](./14-known-gaps.md).

---

## 5. Server → client events

Frame format: `{ event, payload }`.

| `event` | Room | Payload | Sent by |
|---|---|---|---|
| `order:new` | `restaurant:{restaurantId}` | `{ orderId }` | order create (COD), payment success |
| `order:new` | `user:{ownerId}` | `{ orderId }` | same — the dual-emit to the seller |
| `order:update` | `user:{userId}` | `{ orderId, status }` | status change, cancellation |
| `order:update` | `restaurant:{restaurantId}` | `{ orderId, status }` | same |
| `order:update` | `user:{ownerId}` | `{ orderId, status }` | same — the dual-emit |
| `order:rider_assigned` | 4 rooms | `{ order }` (full order) | rider accepted |
| `order:delivered` | `user:{userId}` | full order | delivery complete |
| `order:available` | `user:{riderUserId}` | `{ orderId, restaurantId }` | rider matcher |
| `rider:location` | `order:{orderId}` | `{ orderId, latitude, longitude, at }` | rider GPS |

**Every order lifecycle event is emitted to three parties**: the customer, the restaurant
room, and the restaurant owner. The owner dual-emit exists because the seller may not be
in the `restaurant:` room (see §2).

---

## 6. Broadcasting

```ts
broadcastToRoom(endpoint, room, event, payload) {
  const connectionIds = await getConnectionsInRoom(room);   // GSI query
  if (!connectionIds.length) return;

  await Promise.allSettled(connectionIds.map(async (connectionId) => {
    try {
      await apiClient.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data }));
    } catch (err) {
      if (err instanceof GoneException || err.$metadata?.httpStatusCode === 410)
        await removeConnection(connectionId);      // ← lazy cleanup
      else console.error(`Failed to send to ${connectionId}:`, err);
    }
  }));
}
```

Three properties worth noting:

1. **`Promise.allSettled`, not `all`** — one dead connection never fails the whole
   broadcast.
2. **410 Gone = self-healing.** A browser that closed without a clean `$disconnect` still
   has rows in the registry. The first post attempt returns `GoneException`, and the row
   is deleted right there. The 24-hour TTL is only the backstop.
3. **Empty room = instant return.** No Management API call at all.

The Management API client is a lazily-created module singleton (same warm-container rule
as the DynamoDB client).

---

## 7. Client implementation

`apps/web/src/lib/socket.ts` — a class that deliberately keeps the old Socket.IO surface
(`getSocket` / `on` / `off` / `emit` / `connected`) so no hook or page had to change.

```ts
class RealtimeSocket {
  connect() {
    new WebSocket(`${REALTIME_WS_URL}?token=${encodeURIComponent(this.token)}`);
    ws.onopen    → setConnected(true); dispatch("connect", undefined)   // synthetic
    ws.onmessage → JSON.parse → dispatch(data.event, data.payload)
    ws.onclose   → setConnected(false); if (!closedByUser) scheduleReconnect()
    ws.onerror   → setConnected(false)   // onclose always follows; reconnect handled there
  }
}
```

### Reconnection — never gives up

```
delay = min(500 ms × 2^attempt, 5000 ms)
```

Infinite retries with capped exponential backoff. On success `reconnectAttempt` resets to
0 and a **synthetic `"connect"` event** fires, which is what makes `useSocketEvent`
re-arm its listeners on the live socket. Reconnecting is safe because `$connect` runs
again and re-joins `user:` / `restaurant:` rooms.

### Lifecycle

```
SocketProvider
  isAuthenticated true  → connectSocket()      (fetches/reuses the in-memory bootstrap token)
  was true → now false → disconnectSocket()
  unmount  → disconnectSocket()
```

`connectSocket()` calls `disconnectSocket()` first, so there is never more than one socket.

### Event subscription

```ts
useSocketEvent(event, callback)
```

Uses a ref for the callback (no stale closures) and depends on
`useSocketStore(s => s.isConnected)`, so the effect re-runs on every connect/disconnect
and re-attaches. `useSocketEventOnce` unsubscribes after the first fire.

---

## 8. Cache invalidation — why nothing needs a refresh button

`apps/web/src/hooks/use-realtime-order-sync.ts`:

```ts
const invalidateOrderData = () => {
  queryClient.invalidateQueries({ queryKey: ["orders"] });   // customer + seller boards
  queryClient.invalidateQueries({ queryKey: ["rider"] });    // current order, profile, earnings, history
  queryClient.invalidateQueries({ queryKey: ["cart"] });     // cleared server-side on payment
};

useSocketEvent(SOCKET_EVENTS.ORDER_NEW,        invalidateOrderData);
useSocketEvent(SOCKET_EVENTS.ORDER_UPDATE,     invalidateOrderData);
useSocketEvent(SOCKET_EVENTS.RIDER_ASSIGNED,   invalidateOrderData);
useSocketEvent(SOCKET_EVENTS.ORDER_DELIVERED,  invalidateOrderData);
useSocketEvent(SOCKET_EVENTS.ORDER_AVAILABLE,  invalidateOrderData);
```

The socket is used purely as a **cache-invalidation signal**. The client never trusts the
socket payload as state — it refetches from the HTTP API, which is the source of truth.
That is why every dashboard in the app stays correct with zero manual refresh logic.

---

## 9. Rider GPS streaming

`apps/web/src/hooks/use-rider-location-stream.ts`

```ts
navigator.geolocation.watchPosition(
  pos => emitPing(pos.coords.latitude, pos.coords.longitude),
  () => {},                                             // silent-fail
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
);
```

- Only active when `enabled && orderId` — no active order, no watching, no emits.
- **Client-side throttle to one ping per 5 s**, stored in a ref so it survives re-renders.
- Errors are swallowed: GPS permission revoked mid-delivery must not spam the console.
  `watchPosition` keeps trying and nothing emits until it succeeds.
- Cleanup clears the watch.
- The emit is fire-and-forget; the delivery UI never waits for it.

The server relays it straight into `order:{orderId}`, where the customer's tracking map
(`features/tracking/components/live-tracking-map.tsx`, Leaflet via `react-leaflet`)
consumes it.

---

## 10. Operational notes

**Connection registry growth.** Rows are added on join and removed on `$disconnect`, on
410-Gone during a broadcast, or by the 24-hour TTL. Three independent cleanup paths, so
the table cannot grow unboundedly.

**Cost shape.** Broadcasts are one DynamoDB GSI query plus N `PostToConnection` calls.
`order:available` to 30 nearby riders is 30 posts — the only fan-out that scales with
audience size. Everything else is 1–4 connections.

**Debugging a silent socket:**
1. Is `NEXT_PUBLIC_REALTIME_WS_URL` pointing at the deployed `WebSocketUrl` export?
2. Does the bootstrap token exist? `connectSocket()` logs
   `"[Socket] No bootstrap token; skipping connect"` and returns `null`.
3. Is the `$connect` returning 200? A 401 here is a JWT problem, not a socket problem.
4. Is the room row in `foodo-realtime-<stage>-connections` under the `room-index` GSI?
5. Did the SNS event reach `foodo-realtime-<stage>-emit`? Tail it with
   `pnpm run logs:realtime`.