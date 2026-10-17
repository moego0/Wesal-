import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * Required for next-intl, not optional: `next-intl/config` resolves to a stub
 * that throws unless the plugin aliases it to `src/i18n/request.ts`. Without
 * this wrapper every server-side translation call fails at runtime.
 */
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,

  /**
   * Keep the metrics client out of the bundler.
   *
   * `@/server/metrics/registry` is imported from two entry points that Turbopack
   * compiles separately — `instrumentation.ts` at boot and the route handler at
   * scrape time. If the library is bundled into both, each graph gets its own
   * copy of its module-level state: the route would hold a different Registry
   * from the one `register()` populated, and would serve an empty scrape from a
   * process that looks perfectly healthy. Bundling it twice can also throw
   * `A metric with the name X has already been registered`.
   *
   * Externalizing it means one copy, resolved at run time, shared by both. The
   * `globalThis` pin in `registry.ts` is the other half of this — belt and
   * braces, because this failure mode is silent and this pair of statements is
   * cheap.
   */
  serverExternalPackages: ["@prometheus-io/client"],

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withNextIntl(nextConfig);
