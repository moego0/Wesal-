import { z } from "zod";

/**
 * Server-only environment. Importing this from a client component will fail
 * the build, which is the intended outcome — every value here is a secret.
 */

/**
 * A `"1"`-or-nothing boolean flag.
 *
 * Deliberately not accepting `"true"`, `"yes"`, `"on"` or `"TRUE"`. Every one of
 * those is a plausible thing for an operator to write, and each would then mean
 * something subtly different from the documented value — which is how a flag
 * ends up "set" in an `.env` file and still off in the running process. One
 * accepted spelling, and everything else is off.
 *
 * Exported so `tests/admin.flag.test.ts` can assert that directly rather than
 * through a memoised `env()`.
 */
export function flagEnabled(raw: string): boolean {
  return raw === "1";
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters")
    .refine(
      (v) => !v.startsWith("change-me"),
      "SESSION_SECRET is still the placeholder value. Generate one with:\n" +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    ),

  APP_URL: z.string().url().default("http://localhost:3000"),

  MESSAGING_PROVIDER: z.enum(["mock", "whatsapp_cloud"]).default("mock"),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  MATERIALIZE_HORIZON_HOURS: z.coerce.number().int().positive().max(720).default(72),

  REQUIRE_PRODUCTION_CONFIG: z.string().default("0").transform(flagEnabled),

  /**
   * Whether the worker may populate an EMPTY database with the synthetic demo
   * dataset in `prisma/seed.ts`.
   *
   * That seed deletes every row in the database and creates the demo logins
   * documented in the README, so running it against production would ship
   * `pharmacist@wasal.demo` as a working admin on a public URL. The default is
   * derived from the environment and is safe in both directions: on in
   * development (where `npm run dev` relies on it), off in production (where
   * `scripts/bootstrap-prod.ts` does the real first-run setup).
   *
   * A production database that is empty because the operator forgot the
   * bootstrap will fail loudly at the login screen, which is the correct
   * failure — the alternative is deleting the patient database on a restart.
   */
  AUTO_SEED_DEMO: z
    .string()
    .default(() => (process.env.NODE_ENV === "production" ? "0" : "1"))
    .transform(flagEnabled),

  /**
   * Whether `/admin` exists at all.
   *
   * Same derivation as `AUTO_SEED_DEMO`: on in development so the console needs
   * no setup, off in production so a deployment does not expose an operations
   * surface nobody asked for. A page that is switched off returns 404 — not a
   * redirect, not a "forbidden" — so from outside it is indistinguishable from
   * a route that was never deployed.
   */
  ENABLE_ADMIN: z
    .string()
    .default(() => (process.env.NODE_ENV === "production" ? "0" : "1"))
    .transform(flagEnabled),

  /**
   * Bearer token for `/api/metrics`.
   *
   * Empty means DISABLED, and the endpoint answers 404 — the same fail-closed
   * shape as `ENABLE_ADMIN`. A deployment that never sets this has no metrics
   * endpoint rather than an unauthenticated one, so forgetting to configure it
   * cannot turn into a public data leak. Prometheus sends this value; see
   * `deploy/monitoring/prometheus.yml`.
   */
  METRICS_TOKEN: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const isBuild =
    process.env.npm_lifecycle_event === "build" ||
    process.env.NEXT_PHASE === "phase-production-build";

  const rawEnv = isBuild
    ? {
        DATABASE_URL: "postgresql://build:build@localhost:5432/build",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "build_session_secret_at_least_32_characters_long_for_build",
        ...process.env,
      }
    : process.env;

  const parsed = schema.safeParse(rawEnv);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }

  const env = parsed.data;

  // Config that only matters once real patients are involved. Checked at boot
  // rather than at first send, so a misconfigured deployment fails loudly and
  // immediately instead of quietly at 8am when the first reminder is due.
  if (env.REQUIRE_PRODUCTION_CONFIG) {
    const missing: string[] = [];

    if (env.MESSAGING_PROVIDER === "whatsapp_cloud") {
      if (!env.WHATSAPP_APP_SECRET) missing.push("WHATSAPP_APP_SECRET");
      if (!env.WHATSAPP_ACCESS_TOKEN) missing.push("WHATSAPP_ACCESS_TOKEN");
      if (!env.WHATSAPP_PHONE_NUMBER_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
      if (!env.WHATSAPP_VERIFY_TOKEN) missing.push("WHATSAPP_VERIFY_TOKEN");
    }

    if (missing.length > 0) {
      throw new Error(
        `REQUIRE_PRODUCTION_CONFIG=1 but these are unset: ${missing.join(", ")}`,
      );
    }
  }

  return env;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** True when outbound messages would reach a real human. */
export function isLiveMessaging(): boolean {
  return env().MESSAGING_PROVIDER !== "mock";
}
