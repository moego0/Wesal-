import { z } from "zod";

/**
 * Server-only environment. Importing this from a client component will fail
 * the build, which is the intended outcome — every value here is a secret.
 */

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

  REQUIRE_PRODUCTION_CONFIG: z
    .string()
    .default("0")
    .transform((v) => v === "1"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

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
