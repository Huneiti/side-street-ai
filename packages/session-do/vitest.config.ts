import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Only the in-process suites. `benchmark/` drives a running Worker over
    // the network and has its own config (vitest.benchmark.config.ts).
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Isolated storage can't roll back while WebSockets are open, and
        // these tests hold sockets on purpose; each test isolates itself
        // with a unique session id instead.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        // The Sentry integration's client secret is a deploy-time secret, so
        // it is absent from wrangler.jsonc by design. Tests supply an obvious
        // fake: what they exercise is the HMAC, not the value.
        miniflare: { bindings: { SENTRY_CLIENT_SECRET: "not-a-real-client-secret" } },
      },
    },
  },
});
