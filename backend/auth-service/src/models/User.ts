// Re-export the shared User model + refresh-token helpers.
// The schema's single source of truth is @foodo/backend-common/models —
// auth-service keeps this thin module so the rest of the service (auth
// controllers, tokens lib, seeds) keeps its import paths unchanged.

export {
  User,
  hashRefreshToken,
  newRefreshTokenRaw,
  REFRESH_TTL_MS,
  type IUser,
  type IRefreshToken,
} from "@foodo/backend-common/models";
