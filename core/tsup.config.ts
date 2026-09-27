import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "authorizer": "src/authorizer.ts",
  },
  format: ["cjs"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: true,
  sourcemap: true,
  splitting: false,

  outExtension() {
    return {
      js: ".js",
    };
  },

  // Bundle everything — the authorizer must be a self-contained zip
  // (jsonwebtoken has no native bindings, so this stays tiny).
  noExternal: [/.*/],
  external: [/^@aws-sdk\/.*/],
});
