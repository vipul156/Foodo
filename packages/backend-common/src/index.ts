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
// Mongoose schemas live behind the "./models" subpath — importing them
// from here would make every consumer (even DB-less ones) load mongoose.

// ─── Middlewares ─────────────────────────────────────────────
// Permissive JWT middleware + role guards (restaurant/rider/admin/utils).
export * from "./middlewares/isAuth.js";

// tryCatch (plain) + tryCatchStatus (admin's status-preserving variant)
export * from "./middlewares/trycatch.js";

// Service-to-service INTERNAL_SERVICE_KEY header check
export * from "./middlewares/internal.js";

// Memory-storage single-file upload (multer .single("file"))
export * from "./middlewares/multer.js";

// Cloudinary signed direct-upload helper (local HMAC-SHA1 signing —
// no network hop, no utils-service call). Secret never leaves the process.
export * from "./cloudinary.js";
