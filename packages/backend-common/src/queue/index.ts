// @foodo/backend-common/queue — shared RabbitMQ resilience + messaging.
//
// Import from the "./queue" subpath: keeps amqplib out of the package
// root for consumers that don't touch RabbitMQ.
//
// - resilience.ts: retry-with-backoff + DLQ policy, EventHandler type
// - amqp-manager.ts: createAmqpManager factory (connection lifecycle)
// - messaging.ts: publisher + consumer builders over the manager

export * from "./resilience.js";
export * from "./amqp-manager.js";
export * from "./messaging.js";
