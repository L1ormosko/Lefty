import { assertPasswordMeetsPolicy, hashPassword } from "../src/server/auth";
import { PERMISSION_CATALOG, permissionKey } from "../src/server/authz";
import { prisma } from "../src/server/db";
import { seedFieldOperationsData } from "./seed/seed-field-operations";
import { seedOperationalData } from "./seed/seed-operations";
import { seedTenant } from "./seed/seed-tenant";
import { TENANT_SPECS } from "./seed/tenant-specs";

const MIN_SEED_PASSWORD_LENGTH = 16;

/**
 * Reads the shared development password. It is REQUIRED (no default: a default password in a
 * repository is a credential everyone knows) and is never printed or logged.
 */
function readSeedPassword(): string {
  const password = process.env.SEED_PASSWORD;
  if (!password || [...password].length < MIN_SEED_PASSWORD_LENGTH) {
    throw new Error(
      `Refusing to seed: set SEED_PASSWORD to a secret of at least ${MIN_SEED_PASSWORD_LENGTH} characters (it becomes every seeded user's password).`,
    );
  }
  assertPasswordMeetsPolicy(password); // same policy as real accounts (length, bcrypt byte limit)
  return password;
}

/** Seeds the global permission catalog (idempotent). */
async function seedPermissionCatalog(): Promise<void> {
  for (const def of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: permissionKey(def) },
      update: { description: def.description, sensitive: def.sensitive ?? false },
      create: {
        key: permissionKey(def),
        module: def.module,
        action: def.action,
        description: def.description,
        sensitive: def.sensitive ?? false,
      },
    });
  }
  console.log(`permission catalog: ${PERMISSION_CATALOG.length} permissions`);
}

/**
 * Development seed: the permission catalog plus two fictional tenants (so isolation can be tried
 * by hand), each with legal entities, a US org tree, one user per role template, and the operational
 * catalogs (job types, skills, certifications, lead sources) with qualified technicians.
 *
 * DEVELOPMENT ONLY: refuses to run with NODE_ENV=production. Safe to re-run: existing tenants are
 * skipped. Logging in as the Owner / Finance / HR users needs MFA (their roles require it), so set
 * LEADRO_ENCRYPTION_KEY first (see .env.example) and enroll an authenticator on first login.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo users in production.");
  const password = readSeedPassword();

  await seedPermissionCatalog();
  const passwordHash = await hashPassword(password);
  for (const spec of TENANT_SPECS) {
    const result = await seedTenant(spec, passwordHash);
    if (!result.created) {
      console.log(`tenant ${result.slug}: already exists, left unchanged`);
    } else {
      console.log(`tenant ${result.slug} (company code "${result.slug}"):`);
      for (const person of result.people) console.log(`  ${person.email}  [${person.roleTemplate}, ${person.unit}]`);
    }
    // Operational catalogs + technicians: also fills tenants seeded before Phase 2 (idempotent).
    const operations = await seedOperationalData(result.tenantId, result.slug);
    console.log(
      operations.created
        ? `  operations: ${operations.jobTypes} job types, ${operations.skills} skills, ${operations.certifications} certifications, ${operations.leadSources} lead sources, ${operations.technicians} technicians with ${operations.qualifications} qualifications`
        : "  operations: already seeded, left unchanged",
    );
    // Phase 3 catalogs (lost reasons, default completion forms, the inactive example recovery rule); idempotent.
    const field = await seedFieldOperationsData(result.tenantId);
    console.log(
      `  field operations: ${field.lostReasons} lost reasons, ${field.completionForms} completion forms, ${field.recoveryRules} recovery rule(s) (inactive)`,
    );
  }
  // Both tenants share the password from SEED_PASSWORD; it is intentionally not echoed.
  console.log("seeded users sign in with the SEED_PASSWORD you provided.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
