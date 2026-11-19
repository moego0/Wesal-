import "dotenv/config";
import { defineConfig } from "prisma/config";

function getResolvedDatabaseUrl() {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (!u.hostname.includes(".") && u.hostname.startsWith("dpg-")) {
      u.hostname = `${u.hostname}.oregon-postgres.render.com`;
      if (!u.searchParams.has("sslmode")) {
        u.searchParams.set("sslmode", "require");
      }
      return u.toString();
    }
  } catch {}
  return raw;
}

// Prisma 7 requires the datasource URL here rather than in schema.prisma.
//
// Read via process.env rather than the `env()` helper on purpose: `env()`
// throws when the variable is missing, and every CLI command loads this file —
// so a fresh clone could not even run `prisma generate` before creating a
// .env. Missing configuration is reported precisely by src/server/env.ts
// instead, which is where it actually matters.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: getResolvedDatabaseUrl(),
  },
});
