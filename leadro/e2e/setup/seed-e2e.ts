import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { assertPasswordMeetsPolicy, hashPassword } from "@/server/auth";
import { encryptSecret } from "@/server/auth/secret-box";
import { PERMISSION_CATALOG, permissionKey } from "@/server/authz";
import { prisma, withTenant } from "@/server/db";
import { base32Encode, generateTotpSecret } from "@/lib/totp";
import { seedTenant } from "../../prisma/seed/seed-tenant";
import { TENANT_SPECS, type TenantSpec } from "../../prisma/seed/tenant-specs";
import type { E2eFixture } from "./fixture";
import { E2E_DATABASE_URL } from "./test-database";

/** Prefix that marks the tenants this suite creates, so they are easy to find and clean up by hand. */
export const E2E_TENANT_PREFIX = "e2e-";

const randomSuffix = () => randomBytes(4).toString("hex");

/** Brings the test database to the current schema (forward-only, same command as `npm test`). */
function migrateTestDatabase(): void {
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL } });
}

/** The permission catalog is global (not per tenant); role templates refer to it. Idempotent. */
async function ensurePermissionCatalog(): Promise<void> {
  for (const def of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: permissionKey(def) },
      update: { description: def.description, sensitive: def.sensitive ?? false },
      create: { module: def.module, action: def.action, key: permissionKey(def), description: def.description, sensitive: def.sensitive ?? false },
    });
  }
}

/** A copy of the development tenant under a unique company code. */
function freshTenantSpec(label: string): TenantSpec {
  const base = TENANT_SPECS[0];
  const slug = `${E2E_TENANT_PREFIX}${label}-${randomSuffix()}`;
  return { ...base, slug, name: `E2E ${label} ${slug}` };
}

/**
 * Creates two brand-new tenants in the test database and returns what the specs need.
 *
 * Tenant "main" has the 12 role-template users (CEO, City Manager, Technician, ...). The CEO is
 * enrolled in MFA with a seed generated here. Tenant "other" exists only so the isolation spec
 * has a real record that belongs to somebody else.
 */
export async function seedE2e(): Promise<E2eFixture> {
  migrateTestDatabase();
  await ensurePermissionCatalog();

  const password = randomBytes(18).toString("base64url");
  assertPasswordMeetsPolicy(password);
  const passwordHash = await hashPassword(password);

  const main = await seedTenant(freshTenantSpec("main"), passwordHash);
  const other = await seedTenant(freshTenantSpec("other"), passwordHash);
  const emailOf = (login: string) => `${login}@${main.slug}.example.test`;

  const totpSecret = generateTotpSecret();
  await withTenant(main.tenantId, async (tx) => {
    await tx.user.update({
      where: { tenantId_email: { tenantId: main.tenantId, email: emailOf("owner") } },
      data: { mfaEnabled: true, mfaSecretEncrypted: encryptSecret(totpSecret) },
    });
    await tx.user.update({
      where: { tenantId_email: { tenantId: main.tenantId, email: emailOf("city-manager") } },
      data: { locale: "he-IL" },
    });
  });

  const foreign = await withTenant(other.tenantId, (tx) => tx.employee.findFirstOrThrow({ select: { id: true } }));
  const cityManagerIndex = main.people.findIndex((person) => person.roleTemplate === "CITY_MANAGER");

  return {
    password,
    employeeCount: main.people.length,
    ceo: { email: emailOf("owner"), tenantSlug: main.slug, totpSecretBase32: base32Encode(totpSecret) },
    cityManager: {
      email: emailOf("city-manager"),
      tenantSlug: main.slug,
      employeeNumber: `E-${String(cityManagerIndex + 1).padStart(4, "0")}`,
    },
    technician: { email: emailOf("technician"), tenantSlug: main.slug },
    lockoutTarget: { email: emailOf("dispatcher"), tenantSlug: main.slug },
    foreignEmployeeId: foreign.id,
  };
}
