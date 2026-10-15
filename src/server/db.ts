import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "./env";

/**
 * Prisma 7 gets its connection from a driver adapter rather than the schema.
 */
function buildClient() {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }]
        : [{ emit: "event", level: "error" }],
  });
}

type RawClient = ReturnType<typeof buildClient>;

// Next.js dev mode re-evaluates modules on hot reload; without this the process
// accumulates connection pools until Postgres refuses new connections.
const globalForPrisma = globalThis as unknown as { __wasalPrisma?: RawClient };

const raw: RawClient = globalForPrisma.__wasalPrisma ?? buildClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__wasalPrisma = raw;

/**
 * Models whose rows belong to exactly one pharmacy.
 *
 * `AlertEvent` is deliberately absent: it has no pharmacyId of its own and is
 * only ever reached through its parent Alert.
 */
const TENANT_MODELS = new Set([
  "Patient",
  "ConsentRecord",
  "MedicationRecord",
  "MedicationSchedule",
  "MedicationScheduleRevision",
  "ReminderEvent",
  "ReminderDispatch",
  "InboundMessage",
  "PatientResponse",
  "PatientMessage",
  "FollowUpCase",
  "PharmacistIntervention",
  "RefillRecord",
  "AuditEvent",
  "Alert",
  "RuleDefinition",
  "MessagingChannel",
]);

/**
 * List-shaped operations. These are the ones that leak: a `findMany` without a
 * tenant filter returns every pharmacy's patients, and nothing about the result
 * looks wrong at the call site.
 *
 * Single-record operations (`findUnique`, `update`, `delete`) are not guarded —
 * they address a row by primary key, which the caller must already have
 * obtained under a tenant filter. Guarding them would reject legitimate
 * `findUnique({ where: { id } })` lookups and push developers toward bypassing
 * the guard entirely, which is worse than not having it.
 */
const GUARDED_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/**
 * Fails closed on the query shapes that cause cross-tenant leaks.
 *
 * This is a guard against mistakes, not a substitute for row-level security —
 * see the plan's note on RLS as defence in depth. Worker sweeps legitimately
 * span tenants and use `systemPrisma` instead.
 */
const guarded = raw.$extends({
  name: "tenant-guard",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (TENANT_MODELS.has(model) && GUARDED_OPERATIONS.has(operation)) {
          const where = (args as { where?: Record<string, unknown> } | undefined)?.where;

          if (where?.pharmacyId === undefined) {
            throw new Error(
              `Tenant guard: ${model}.${operation}() was called without a pharmacyId ` +
                `filter. Add one, or use \`systemPrisma\` if this is trusted ` +
                `infrastructure code that legitimately spans pharmacies.`,
            );
          }
        }

        return query(args);
      },
    },
  },
});

/**
 * Tenant-guarded client. Use this everywhere in application and UI code.
 */
export const prisma = guarded;

/**
 * Unguarded client. Reserved for infrastructure that legitimately operates
 * across pharmacies: the worker sweeps, inbound webhook routing (which resolves
 * the pharmacy *from* the message), and session lookup.
 *
 * Every call site is a deliberate decision, which is the point.
 */
export const systemPrisma = raw;

export type Db = typeof guarded;
export type { RawClient };
