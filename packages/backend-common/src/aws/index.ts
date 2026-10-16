// @foodo/backend-common/aws — AWS serverless primitives shared by all
// services (DynamoDB, SNS/SQS eventing, geo fallbacks, HTTP caching).
//
// Import from the "./aws" subpath: keeps @aws-sdk/* out of the package
// root for consumers that stay on the realtime tier.

export * from "./dynamodb.js";
export * from "./geo.js";
export * from "./messaging.js";
export * from "./cache.js";
export * from "./http.js";
