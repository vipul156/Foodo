// ─── Session auth (shared implementation) ──────────────────────
// utils-service authenticates SELLERS on the photo routes with the same
// cookie-session identity plane as the rest of the platform. The
// implementation is shared so the JWT normalization rules (sub / id / _id
// across token generations, gateway-verified claims) stay identical
// everywhere.

export { isAuth, isSeller, type AuthRequest } from "@foodo/backend-common";
