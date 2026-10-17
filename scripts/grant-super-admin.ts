import "dotenv/config";
import { systemPrisma } from "../src/server/db";

/**
 * Move the platform-owner flag to an existing account, or take it away.
 *
 * `User.isSuperAdmin` is the one power no permission can grant: it creates
 * pharmacies and every pharmacy account, and it opens every pharmacy. The flag
 * belongs to exactly the website owner, so moving it is an operator action done
 * deliberately — there is no screen for it, and no role can reach it.
 *
 * Usage (from the machine that can reach DATABASE_URL):
 *
 *   npm run db:grant-super-admin -- owner@example.com
 *   npm run db:grant-super-admin -- owner@example.com --revoke
 *
 * The address may also come from SUPER_ADMIN_EMAIL, which keeps the email out
 * of shell history. The account must already exist: this script never creates
 * one, because a typo here would otherwise mint a second owner.
 *
 * It is idempotent — granting an owner the flag again is a no-op that says so,
 * and so is revoking a flag that was already off.
 */

function fail(message: string): never {
  console.error(`\n  grant-super-admin: ${message}\n`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const emailArg = args.find((arg) => !arg.startsWith("--"));
  const email = (emailArg ?? process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();

  if (!email) {
    fail(
      "an email address is required.\n" +
        "    npm run db:grant-super-admin -- owner@example.com\n" +
        "    npm run db:grant-super-admin -- owner@example.com --revoke",
    );
  }

  const user = await systemPrisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, fullName: true, isSuperAdmin: true },
  });

  if (!user) {
    fail(`no account exists with the address ${email}. Create the account first.`);
  }

  if (revoke && !user.isSuperAdmin) {
    console.log(`\n  ${user.email} is not a platform owner; nothing to revoke.\n`);
    return;
  }

  if (!revoke && user.isSuperAdmin) {
    console.log(`\n  ${user.email} is already a platform owner; nothing to change.\n`);
    return;
  }

  await systemPrisma.user.update({
    where: { id: user.id },
    data: { isSuperAdmin: !revoke },
  });

  console.log("");
  console.log("  ── platform owner updated ────────────────────────────────────");
  console.log(`  account    ${user.fullName} <${user.email}>`);
  console.log(`  isSuperAdmin  ${revoke ? "false (revoked)" : "true (granted)"}`);
  console.log("");
  console.log(
    revoke
      ? "  They keep whatever pharmacy access their memberships gave them."
      : "  They can now create pharmacies and accounts, and open every pharmacy.",
  );
  console.log("");
}

main()
  .catch(async (err) => {
    console.error("\n  grant-super-admin failed:", err instanceof Error ? err.message : err);
    console.error("");
    process.exitCode = 1;
  })
  .finally(async () => {
    await systemPrisma.$disconnect();
  });
