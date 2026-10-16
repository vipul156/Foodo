// @foodo/backend-common — shared Node-only utilities for Foodo services.
//
// Rules for this package:
//   1. NEVER import from apps/web or any browser-targeted code. Nothing here
//      may end up in a browser bundle.
//   2. Node-specific runtime dependencies (jsonwebtoken, multer, express)
//      are peerDependencies — the consuming service controls the version.
//   3. This package holds only code that is genuinely identical across
//      services. auth-service's STRICT isAuth is intentionally NOT here.
//
// Subpath exports: ./dynamo (repositories), ./aws (doc client + SNS/SQS),
// ./cloudinary, ./files. The old mongoose models/, Mongo connection
// (db.ts) and RabbitMQ queue/ layers were removed when the platform moved
// to DynamoDB + SNS/SQS.

// ─── Middlewares ─────────────────────────────────────────────
// Permissive JWT middleware + role guards (restaurant/rider/admin/utils).
export * from "./middlewares/isAuth.js";

// tryCatch (plain) + tryCatchStatus (admin's status-preserving variant)
export * from "./middlewares/trycatch.js";

// Memory-storage single-file upload (multer .single("file"))
export * from "./middlewares/multer.js";

// Cloudinary signed direct-upload helper (local HMAC-SHA1 signing —
// no network hop, no utils-service call). Secret never leaves the process.
export * from "./cloudinary.js";
