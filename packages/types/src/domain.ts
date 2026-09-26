// Shared domain types live here. Start by promoting types that are duplicated
// across apps/web (src/types) and the backend services (e.g. JWT claim shapes,
// order status unions, API response envelopes).
//
// Example shape (uncomment and adapt when promoting real types):
//
// export type UserRole = "customer" | "seller" | "rider" | "admin";
//
// export interface AccessClaims {
//   sub: string;
//   role: UserRole;
//   typ: "access";
//   iat?: number;
//   exp?: number;
// }

export {};
