// @foodo/types — universal TypeScript definitions shared by all Foodo apps.
//
// Rules for this package:
//   0. Zero runtime dependencies — types, DTOs, and enums ONLY.
//   1. Must be importable by BOTH the browser (apps/web) and Node services
//      (backend/*-service) without any Node polyfills (no `fs`, `path`, etc.).
//   2. Values allowed here: `const` objects, enums, and plain functions that
//      are pure/serializable (e.g. helpers that derive labels from enums).
//      Anything that touches express, mongoose, react, etc. belongs elsewhere.

export * from "./domain.js";
