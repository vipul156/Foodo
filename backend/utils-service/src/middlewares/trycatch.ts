// ─── Shared error wrapper ─────────────────────────────────────
// The platform keeps ONE tryCatch implementation in @foodo/backend-common
// so every service renders the same 500 JSON envelope. This file is the
// utils-service-local import path (the routers/controllers import
// "../middlewares/trycatch.js") — the logic itself lives in the shared
// package, not in a per-service copy.

export { tryCatch } from "@foodo/backend-common";
