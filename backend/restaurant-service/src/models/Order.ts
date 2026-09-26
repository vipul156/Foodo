// Re-export the shared Order model.
// The schema's single source of truth is @foodo/backend-common/models —
// restaurant-service keeps this thin module so controllers, consumers
// and scripts keep their import paths unchanged.

export { Order, type IOrder } from "@foodo/backend-common/models";
