// @foodo/backend-common/dynamo — DynamoDB repositories replacing the
// shared mongoose models.
//
// Import from the "./dynamo" subpath, NOT the package root: root imports
// stay AWS-free so services that never touch the DB (realtime tier)
// don't pull the SDK into their runtime.
//
// One file per aggregate (User, Rider, Restaurant, Order) mirroring the
// old models/ layout. Service-local models (Cart, MenuItem, Address) live
// in their owning service under src/dynamo/.

export * from "./User.js";
export * from "./Rider.js";
export * from "./Restaurant.js";
export * from "./Order.js";

// AI-tier support tables: goodwill vouchers issued by the arbiter and
// the human-in-the-loop review queue it parks cases in.
export * from "./Voucher.js";
export * from "./ReviewQueue.js";

// Visual-verification verdicts (packing checks + proof of delivery).
export * from "./Verification.js";

// DynamoDB-backed fixed-window rate limiter (replaces the Redis store
// the old AI-tier services used — the platform has no Redis).
export * from "./rateLimit.js";
