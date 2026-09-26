// @foodo/backend-common/models — shared mongoose schemas + admin data ops.
//
// Import from the "./models" subpath, NOT the package root: root imports
// stay mongoose-free so services that never touch the DB (utils-service)
// don't pull mongoose/bcrypt into their runtime.

export * from "./schemas.js";
export * from "./internal.js";
