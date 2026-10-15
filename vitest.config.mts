import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests hit the real Postgres and must not interleave.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
});
