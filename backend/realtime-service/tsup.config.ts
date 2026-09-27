import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "eventConsumer": "src/handlers/eventConsumer.ts",
    "wsRouter": "src/handlers/wsRouter.ts",
  },
  format: ["cjs"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: true,
  sourcemap: true,
  splitting: false,

  // Force the output file to be named "index.js" (matches Lambda's index.handler)
  outExtension() {
    return {
      js: ".js",
    };
  },

  // Bundle EVERYTHING (including express, stripe, and @foodo/* workspace packages)
  // except the AWS SDK which is pre-installed in Lambda Node 20
  noExternal: [/.*/],
  external: [/^@aws-sdk\/.*/],
});