# 05 — Authentication & Sessions

Everything in this document lives in `backend/auth-service/` plus the shared middleware in
`packages/backend-common/`.

---

## 1. The token model — two tokens, two cookies

| | Access token | Refresh token |
|---|---|---|
| Format | **JWT**, HS256 | **Opaque random string**, not a JWT |
| Claims | `{ sub, role, typ: "access" }` only | none |
| Lifetime | 15 minutes | 30 days |
| Transport | `session` cookie (cookie-session) | its own cookie, `path=/api/auth` |
| Storage | — | SHA-256 hash in DynamoDB |
| Revocable | **No** — dies naturally at expiry | **Yes**, server-side row |
| Sent to | all `/api/*` | `/api/auth/*` only |

### Why two

- An **access JWT** cannot be revoked (that's what a JWT *is*), so it is kept tiny and
  short-lived. 15 minutes is the price of stateless verification.
- A **refresh token** is opaque precisely so the server *can* revoke it. If it were a JWT
  you could never kill a session before expiry.
- **Minimal claims on purpose.** Only `sub` + `role`. Name, email and profile live in the
  database and come from `/me`, because they change and every extra byte in a cookie is
  transport cost and tamper surface. **No PII in the token payload.**
- `typ: "access"` is the marker that lets auth-service's strict middleware reject legacy
  full-user tokens.

```ts
// lib/tokens.ts
export const ACCESS_TTL_SEC = 15 * 60;

signAccessToken(sub, role) =>
  jwt.sign({ role, typ: "access" }, JWT_SECRET, { subject: sub, expiresIn: ACCESS_TTL_SEC });
```

---

## 2. Cookie configuration

### Session cookie (`cookie-session`, name `session`)

Set only by auth-service, hardened there:

```ts
{
  name: "session",
  keys: [COOKIE_SECRET],
  maxAge: ACCESS_TTL_SEC * 1000,   // 15 min — matches the JWT, not 24 h
  httpOnly: true,
  sameSite: "lax",
  secure: NODE_ENV === "production",
}
```

Sibling services (restaurant, rider, admin, utils) still mount `cookieSession` with their
older 24-hour `maxAge` and no security flags — they only **read** the cookie; auth-service
sets the flags on the cookies it minted.

### Refresh cookie (name from `REFRESH_COOKIE_NAME`, default `refresh_token`)

```ts
{
  httpOnly: true,                 // XSS cannot read it
  secure: isProd(),
  sameSite: "lax",                // CSRF-safe for top-level navigation
  path: "/api/auth",              // never sent to /api/restaurant, /api/cart, …
  maxAge: REFRESH_TTL_MS,         // 30 days
}
```

`path=/api/auth` is the important one: a leaked-to-subdomain or over-broad request to any
other endpoint never carries the refresh token.

---

## 3. Endpoints

| Method | Path | Gateway | In-app guard |
|---|---|---|---|
| POST | `/api/auth/register` | public | `authFloodLimiter` |
| POST | `/api/auth/login` | public | `authFloodLimiter`, `bruteForceLimiter` |
| POST | `/api/auth/refresh` | public | none (auth = presenting the cookie) |
| POST | `/api/auth/logout` | **protected** | `isAuth` |
| GET | `/api/auth/me` | **protected** | `isAuth` |
| GET | `/api/auth/socket-token` | **protected** | `isAuth` |
| GET | `/health/auth` | public | — |

Register/login/refresh must stay public (no token exists yet). The other three are
gateway-protected *and* guarded in-app — defense in depth, so an unauthenticated call is
rejected before the Lambda is even invoked.

---

## 4. Register / login

Shared tail — `issueSession(res, { id, role })`:

1. `issueRefreshToken()` → `{ raw, tokenHash, expiresAt }`
2. `grantRefreshToken(userId, tokenHash, expiresAt)` — writes a `REFRESH#<hash>` row
   with a TTL.
3. `signAccessToken(userId, role)`
4. `res.cookie(refreshCookieName, refresh.raw, refreshCookieOptions())`
5. Caller sets `req.session = { jwt: accessJwt }` — `cookie-session` reads `req.session`
   to serialize `Set-Cookie`.

**Register:** role must be in `["customer", "rider", "seller"]` — **`admin` cannot be
self-registered**. Duplicate email → 400. Password hashed with
`bcrypt.hash(password, 10)`.

**Login:** missing user → 400 `"User not found"` + `recordAuthFailure`. Wrong password →
400 `"Invalid password"` + `recordAuthFailure`. Success → `clearAuthFailures`, then issue.

`publicUser()` returns `_id` (not `id`) — the web app's contract still uses the
Mongo-style `_id` key, and that key is load-bearing across every React component.

---

## 5. Refresh — rotation and reuse detection

`POST /api/auth/refresh`, cookie-scoped to `/api/auth` so the browser only sends it here.

```
1. Read cookie → hash it
2. getUserByRefreshTokenHash(hash)          (GSI: refresh-index)
   not found  → 401 "Invalid refresh token; please log in again"
3. row.revokedAt set  →  REUSE DETECTED:
      revokeAllActiveRefreshTokens(userId)  ← burn every active session
      req.session = null; clearCookie
      → 401 "Session revoked (token reuse detected); please log in again"
4. Date.parse(row.expiresAt) <= now  → 401 "Refresh token expired"
5. Rotation:
      revokeRefreshToken(userId, presentedHash, next.tokenHash)   ← link the chain
      grantRefreshToken(userId, next.tokenHash, next.expiresAt)
      req.session = { jwt: newAccessJwt }
      res.cookie(refreshCookieName, next.raw, …)
      → 200 { message, accessToken, user }
```

### Reuse detection — the important part

A refresh token is **single-use**. If a token that was already revoked comes back, the
only explanations are theft or a replay. The response is to revoke **every active session
of that user**, which logs out both the thief and the legitimate client. That is
intentional: recovering the session is cheap, a silent attacker is not.

`replacedByHash` links each generation to the next, which makes chain walks and family
audits possible.

Expired rows need no cleanup code — DynamoDB's TTL sweeps them. Expired rows are also
rejected on use, so the sweep window is invisible to users.

### Client-side single-flight

```ts
let refreshInFlight: Promise<void> | null = null;
refreshSession() {
  if (!refreshInFlight) refreshInFlight = (async () => { … })().finally(() => refreshInFlight = null);
  return refreshInFlight;
}
```

Ten components hitting 401 at once produce **one** `POST /api/auth/refresh`.

### Automatic 401 → refresh → retry

In `apps/web/src/lib/api-client.ts`:

```
request(url)
  └─ requestOnce → 401?
       └─ no  → throw ApiError
       └─ yes → exempt? (refresh / login / register) → throw
                else → await refreshSession() → requestOnce(url) again
```

A second 401 propagates — the session is genuinely dead. Refresh is never retried
recursively because `/api/auth/refresh` is in `AUTH_RETRY_EXEMPT`.

---

## 6. `/me` — the source of truth for the profile

```
claims.sub → getUserById → strip password → 200 { user }
```

The JWT is unforgeable but **stale by design** — roles can change. `/me` is why the
frontend's `useCurrentUser` (`staleTime: 5 min`, `retry: false`) exists.

---

## 7. Logout — real revocation, not just cookie clearing

```
1. revokeRefreshToken(sub, presentedHash, null)   ← server-side kill
2. req.session = null                             ← drop the session cookie
3. res.clearCookie(refreshCookieName, …)
4. → 200 "Logged out successfully"
```

The **access JWT dies naturally within ≤ 15 minutes**. That is the accepted cost of
stateless verification and is called out explicitly in the source comment.

Frontend `useLogout` also: calls `/logout`, `clearSocketToken()`, resets the Zustand
store, `localStorage.removeItem("foodo-auth")`, then routes to `/login` with a
`window.location.href` hard-navigation fallback for a guaranteed clean state.

---

## 8. The socket bootstrap token

`GET /api/auth/socket-token` → `{ token, expiresIn: 900 }`.

The WebSocket API is a **separate API Gateway**, so cookies do not apply. The handshake
needs an explicit JWT.

- **Previously:** the long-lived JWT was returned in the login body and stashed in
  `sessionStorage` — reachable by any XSS.
- **Now:** the browser fetches a short-lived token on demand, authenticated by the session
  cookie, and `api-client.ts` keeps it in a **module-level variable only**. Memory dies
  with the page. `clearSocketToken()` on logout.

---

## 9. Middleware — three layers, three jobs

### Layer 1 — gateway `jwtAuthorizer` (`core/src/authorizer.ts`)

Identity only. See [03 Infrastructure §2.2](./03-infrastructure.md). Verifies signature
and expiry; rejects before invocation. No role logic. No result caching.

### Layer 2 — `isAuth` (shared, permissive) — `packages/backend-common/src/middlewares/isAuth.ts`

Its only job is to **reconstruct `req.user`**, because verification already happened:

1. **Preferred** — read `event.requestContext.authorizer.lambda` from
   `req.apiGateway` (serverless-http exposes the raw event; v3+ nests it as
   `{ event, context }`). If `claims.sub` exists, use it. **No re-verification.**
2. **Fallback** — `jwt.decode(req.session.jwt)`. Safe because every route reaching this
   middleware is gateway-protected. Decode ≠ verify, and that distinction is deliberate
   and documented.

Compatibility shims it performs:
- Unwraps a nested `{ user: { … } }` payload (legacy re-signed tokens from `getMyRestaurant`).
- `normalizeIds()` mirrors `sub` / `id` / `_id` onto each other across token generations.

### Layer 2′ — `isAuth` (auth-service's STRICT copy) — `backend/auth-service/src/middlewares/isAuth.ts`

Deliberately **stricter and not shared**: it *rejects* anything without
`typ === "access"` and a present `sub`. This is how legacy full-user tokens are refused
in auth-service while sibling services keep working. **Do not merge the two.**

### Layer 3 — role guards (shared)

```ts
isSeller  → reject only if req.user EXISTS and role !== "seller"
isAdmin   → reject only if req.user EXISTS and role !== "admin"
isRider   → reject if req.user is MISSING or role !== "rider"
```

⚠️ **Known quirk, preserved verbatim** from the original per-service code: `isSeller` and
`isAdmin` let an **unauthenticated** request pass when `req.user` is unset (falsy guard).
Only a *present* user with the wrong role is rejected. `isRider` is the inverse — a
missing user is rejected. In practice the gateway authorizer already rejected anonymous
traffic, so the quirk is unreachable; it is preserved for behavioural parity, not
endorsed.

---

## 10. Rate limiting

`backend/auth-service/src/middlewares/rate-limit.ts` — two layers, both in-memory
(per warm container).

### Layer 1 — `authFloodLimiter`

`express-rate-limit`, 20 credential attempts per 5 minutes per IP, keyed with the library's
IPv6-safe `ipKeyGenerator`. Standard headers on, legacy headers off.

### Layer 2 — `bruteForceLimiter` — failure-only, keyed by IP **+ email**

The insight: an attacker with many IPs can still burn the *targeted account's* budget,
and a legitimate user's successful logins never count against them. So failures are
tracked separately:

```
10 failures per 15 minutes per (IP, lowercased email) → 429
```

Controllers call `recordAuthFailure(req)` on the error paths and `clearAuthFailures(req)`
on success; the limiter is a plain middleware that consults the counters *before* the
route handler runs, so it never touches the database.

An `unref()`-ed `setInterval` sweeps expired entries every 60 s so the `Map` cannot grow
without bound.

⚠️ In-memory state means limits are per-container. Documented upgrade path: the Redis
store (`rate-limit-redis` + `REDIS_URL`), which the utils service previously used.

### Elsewhere

- `utils-service`: `paymentCreateLimiter` **10/min** (money-adjacent),
  `webhookLimiter` **300/min** (signature-verified, but a runaway provider loop must not
  spin the function).
- The authoritative per-IP enforcement point for a serverless deployment is API Gateway
  usage plans / throttling, which is IaC — not currently declared.

---

## 11. Identity across services — what a request carries

```
Cookie: session=<cookie-session signed value>
        refresh_token=<opaque>     ← only when path starts with /api/auth
```

Inside a service:
```
req.session.jwt                      ← the access JWT
req.user                             ← { sub, _id, id, role }  (from gateway claims or decode)
```

Roles are read **only** from verified claims, never from a request body or query string.

---

## 12. Cognito — provisioned, not wired

`infra` creates a user pool and a public SPA client with an issuer URL export. The
platform does not use them; `JWT_SECRET` remains authoritative. When migration happens,
`core/src/authorizer.ts` swaps `jwt.verify(token, JWT_SECRET)` for JWKS verification and
nothing else changes — no service, no client, no table.