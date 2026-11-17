import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    http: "src/handlers/http.ts",
    disputeConsumer: "src/handlers/disputeConsumer.ts",
  },
  format: ["cjs"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: true,
  sourcemap: true,
  splitting: false,

  outExtension() {
    return { js: ".js" };
  },

  // Bundle EVERYTHING (including express + the @foodo/* workspace
  // packages) except the AWS SDK, which is pre-installed in Lambda
  // Node 20.
  noExternal: [/.*/],
  external: [/^@aws-sdk\/.*/],
});
