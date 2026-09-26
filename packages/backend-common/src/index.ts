// @foodo/backend-common — shared Node-only utilities for Foodo services.
//
// Rules for this package:
//   1. NEVER import from apps/web or any browser-targeted code. Nothing here
//      may end up in a browser bundle.
//   2. Node-specific runtime dependencies (mongoose, ioredis, amqplib, etc.)
//      go in peerDependencies as services adopt shared code from here, so the
//      consuming service controls the actual version.
//   3. Prefer re-exporting the *service's own* choices — this package holds
//      only code that is genuinely identical across services.

export * from "./middlewares/trycatch.js";
