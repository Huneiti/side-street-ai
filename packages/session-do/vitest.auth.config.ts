import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// The verified half of the identity work (ADR-0005). Separate from
// `vitest.config.ts` because the token secret is a Worker binding: the same
// runtime cannot be in both modes, and insecure mode is what `test/` covers.
export default defineWorkersConfig({
  test: {
    include: ["test-auth/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            SENTRY_CLIENT_SECRET: "not-a-real-client-secret",
            SIDE_STREET_TOKEN_SECRET: "not-a-real-token-secret",
          },
        },
      },
    },
  },
});
