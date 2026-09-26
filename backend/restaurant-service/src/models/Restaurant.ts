// Re-export the shared Restaurant model.
// The schema's single source of truth is @foodo/backend-common/models —
// restaurant-service keeps this thin module so controllers, seeds and
// consumers keep their import paths unchanged.

export { Restaurant, type IRestaurant } from "@foodo/backend-common/models";
