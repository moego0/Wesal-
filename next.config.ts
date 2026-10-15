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
