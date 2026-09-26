// @foodo/backend-common/models — shared mongoose schemas.
//
// Import from the "./models" subpath, NOT the package root: root imports
// stay mongoose-free so services that never touch the DB (utils-service)
// don't pull mongoose/bcrypt into their runtime.
//
// NOTE: only schemas + models live here. Service-specific query logic
// belongs to the service that presents it (admin's aggregations live in
// admin-service).

export * from "./schemas.js";

// Read-only cross-service queries (rider dashboards, payment
// reconciliation) — shared so every consumer executes identical logic
// in-process instead of querying the owning service over HTTP.
export * from "./order-queries.js";
