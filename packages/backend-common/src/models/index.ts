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
