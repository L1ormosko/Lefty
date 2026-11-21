import { bootstrapRoleAssignment, provisionRoleTemplates } from "../../src/server/authz";
import { prisma, withTenant, type TenantTx } from "../../src/server/db";
import { PEOPLE, type TenantSpec, type UnitSpec } from "./tenant-specs";

export interface SeededPerson {
  email: string;
  roleTemplate: string;
  unit: string;
}

export interface SeedTenantResult {
  slug: string;
  tenantId: string;
  /** False when the tenant already existed and nothing was changed. */
  created: boolean;
  people: SeededPerson[];
}

const DAY_MS = 86_400_000;

/** Creates the org tree depth-first; returns `unitKey -> orgUnitId`. */
async function createUnits(
  tx: TenantTx,
  tenantId: string,
  specs: UnitSpec[],
  legalEntityIds: Map<string, string>,
  parentId: string | null,
  into: Map<string, string>,
): Promise<void> {
  for (const spec of specs) {
    const unit = await tx.orgUnit.create({
      data: {
        tenantId,
        type: spec.type,
        name: spec.name,
        parentId,
        legalEntityId: spec.legalEntity ? legalEntityIds.get(spec.legalEntity) : undefined,
        address: spec.address,
        timeZone: spec.timeZone,
      },
      select: { id: true },
    });
    into.set(spec.key, unit.id);
    await createUnits(tx, tenantId, spec.children ?? [], legalEntityIds, unit.id, into);
  }
}

const unitLegalEntity = (specs: UnitSpec[], key: string): string | undefined => {
  for (const spec of specs) {
    if (spec.key === key) return spec.legalEntity;
    const found = unitLegalEntity(spec.children ?? [], key);
    if (found) return found;
  }
  return undefined;
};

/**
 * Creates one development tenant: legal entities, the org tree, the 12 role templates and one
 * ACTIVE user per template (with an employee record placed in the org tree and the role granted
 * with an explicit scope). Idempotent by company code: an existing tenant is left untouched.
 *
 * `passwordHash` is computed once by the caller; the plain password never reaches this function.
 * Everything runs in one transaction, so a failure leaves no half-seeded tenant behind.
 */
export async function seedTenant(spec: TenantSpec, passwordHash: string): Promise<SeedTenantResult> {
  const existing = await prisma.tenant.findUnique({ where: { slug: spec.slug }, select: { id: true } });
  if (existing) return { slug: spec.slug, tenantId: existing.id, created: false, people: [] };

  const tenant = await prisma.tenant.create({ data: { slug: spec.slug, name: spec.name } });
  const tenantId = tenant.id;

  // `Tenant` is created outside the tenant transaction (withTenant needs its id first). If anything
  // below fails, the tenant would otherwise remain as an EMPTY company that every re-run skips as
  // "already exists". So a failure removes it again; the tenant-scoped rows roll back with their transaction.
  let people: SeededPerson[];
  try {
    people = await withTenant(
      tenantId,
      async (tx) => {
        const legalEntityIds = new Map<string, string>();
        for (const entity of spec.legalEntities) {
          const created = await tx.legalEntity.create({
            data: { tenantId, name: entity.name, legalName: entity.legalName },
            select: { id: true },
          });
          legalEntityIds.set(entity.key, created.id);
        }
        const unitIds = new Map<string, string>();
        await createUnits(tx, tenantId, spec.units, legalEntityIds, null, unitIds);

        const roleIds = await provisionRoleTemplates(tx, tenantId);
        const placedSince = new Date(Date.now() - 30 * DAY_MS);
        const seeded: SeededPerson[] = [];

        for (const [index, person] of PEOPLE.entries()) {
          const email = `${person.login}@${spec.slug}.example.test`;
          const unitId = unitIds.get(person.placeAt);
          const roleId = roleIds[person.templateKey];
          if (!unitId || !roleId) throw new Error(`Seed spec error: ${person.templateKey} / ${person.placeAt}`);
          const legalEntityKey = unitLegalEntity(spec.units, person.placeAt);

          const user = await tx.user.create({
            data: { tenantId, email, passwordHash, status: "ACTIVE", passwordChangedAt: new Date() },
            select: { id: true },
          });
          await tx.employee.create({
            data: {
              tenantId,
              userId: user.id,
              legalEntityId: legalEntityKey ? legalEntityIds.get(legalEntityKey) : undefined,
              employeeNumber: `E-${String(index + 1).padStart(4, "0")}`,
              firstName: spec.firstNames[index % spec.firstNames.length],
              lastName: spec.lastNames[index % spec.lastNames.length],
              email,
              jobTitle: person.jobTitle,
              hireDate: placedSince,
              assignments: { create: { orgUnitId: unitId, kind: "PRIMARY", effectiveFrom: placedSince, reason: "Development seed" } },
            },
          });
          await bootstrapRoleAssignment(tx, {
            tenantId,
            userId: user.id,
            roleId,
            reason: "Development seed",
            scopes: person.scopes.map((scope) => {
              if (scope.type !== "ORG_UNIT") return { type: scope.type };
              const orgUnitId = unitIds.get(scope.unitKey ?? "");
              if (!orgUnitId) throw new Error(`Seed spec error: scope unit ${scope.unitKey}`);
              return { type: scope.type, orgUnitId, includeDescendants: true };
            }),
          });
          seeded.push({ email, roleTemplate: person.templateKey, unit: person.placeAt });
        }
        return seeded;
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    throw error;
  }

  return { slug: spec.slug, tenantId, created: true, people };
}
