// ─── Internal service auth (shared implementation) ─────────────
// Service-to-service calls carry `x-internal-key`. The constant-time,
// fail-closed comparison lives in @foodo/backend-common so every service
// enforces it identically.

export { isInternal } from "@foodo/backend-common";
