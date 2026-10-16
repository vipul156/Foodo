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
