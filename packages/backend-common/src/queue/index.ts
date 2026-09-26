// @foodo/backend-common/queue — shared RabbitMQ consumer resilience.
//
// Import from the "./queue" subpath: keeps amqplib out of the package
// root for consumers that don't touch RabbitMQ.

export * from "./resilience.js";
