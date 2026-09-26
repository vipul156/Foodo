// Re-export the shared Rider model.
// The schema's single source of truth is @foodo/backend-common/models —
// rider-service keeps this thin module so controllers, consumers and
// seeds keep their import paths unchanged.

export { Rider, type IRider } from "@foodo/backend-common/models";
