// ─── HTTP caching: the API Gateway + CloudFront tier ─────────
// Replaces the Redis cache role for hot GETs (menus, restaurants,
// nearby lists). Services stamp Cache-Control on GET responses; API
// Gateway forwards the header and CloudFront caches at the edge, so a
// hot menu never re-executes the Lambda for every viewer.
//
// Rules of thumb baked into the helpers:
//   - public catalog data (menus, restaurant cards)  → public + s-maxage
//   - anything authenticated/personalized (carts, orders, /me)
//     → private or no-store; CloudFront must never share those.
//   - SSE/None-GET never gets cache headers.

/**
 * Public, edge-cacheable GET. `sMaxAgeSec` is what CloudFront honors;
 * `browserSec` (default 60) lets already-fetched clients reuse briefly.
 * `staleWhileRevalidate` lets the edge serve stale while refreshing.
 */
export function setCacheablePublic(
  res: { setHeader: (name: string, value: string) => unknown },
  sMaxAgeSec: number,
  browserSec = 60,
  staleWhileRevalidate?: number,
): void {
  const swr = staleWhileRevalidate
    ? `, stale-while-revalidate=${staleWhileRevalidate}`
    : "";
  res.setHeader(
    "Cache-Control",
    `public, max-age=${browserSec}, s-maxage=${sMaxAgeSec}${swr}`,
  );
}

/**
 * Auth-scoped GET (carts, orders, profiles): browsers may cache for a
 * few seconds, the shared edge must not.
 */
export function setCacheablePrivate(
  res: { setHeader: (name: string, value: string) => unknown },
  browserSec = 5,
): void {
  res.setHeader(
    "Cache-Control",
    `private, max-age=${browserSec}, no-cache`,
  );
}

/** Never cache: payments, verification writes, webhooks. */
export function setNoCache(
  res: { setHeader: (name: string, value: string) => unknown },
): void {
  res.setHeader("Cache-Control", "no-store");
}
