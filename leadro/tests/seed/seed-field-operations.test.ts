import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth";
import { prisma, withTenant } from "@/server/db";
import { JOB_TYPES } from "../../prisma/seed/operations-specs";
import { EXAMPLE_RECOVERY_RULE, LOST_REASONS } from "../../prisma/seed/field-specs";
import { seedFieldOperationsData, type SeedFieldOperationsResult } from "../../prisma/seed/seed-field-operations";
import { seedOperationalData } from "../../prisma/seed/seed-operations";
import { seedTenant } from "../../prisma/seed/seed-tenant";
import { TENANT_SPECS } from "../../prisma/seed/tenant-specs";

const suffix = Math.random().toString(36).slice(2, 8);
const spec = { ...TENANT_SPECS[0], slug: `fieldseed-a-${suffix}` };
const otherSpec = { ...TENANT_SPECS[1], slug: `fieldseed-b-${suffix}` };
let tenantId: string;
let otherTenantId: string;
let result: SeedFieldOperationsResult;

beforeAll(async () => {
  const passwordHash = await hashPassword("dev-seed-password-123");
  tenantId = (await seedTenant(spec, passwordHash)).tenantId;
  otherTenantId = (await seedTenant(otherSpec, passwordHash)).tenantId;
  await seedOperationalData(tenantId, spec.slug);
  await seedOperationalData(otherTenantId, otherSpec.slug);
  result = await seedFieldOperationsData(tenantId);
  await seedFieldOperationsData(otherTenantId);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phase 3 development seed", () => {
  it("creates the spec 9.2 lost reasons, with the not-recoverable one flagged", async () => {
    expect(result.lostReasons).toBe(LOST_REASONS.length);
    await withTenant(tenantId, async (tx) => {
      const reasons = await tx.lostReason.findMany({ orderBy: { sortOrder: "asc" } });
      expect(reasons.map((r) => r.code)).toEqual(LOST_REASONS.map((r) => r.code));
      expect(reasons.find((r) => r.code === "price-too-high")).toMatchObject({ appliesTo: ["NOT_SOLD"], recoverable: true, active: true });
      expect(reasons.find((r) => r.code === "outside-service-capabilities")?.recoverable).toBe(false);
    });
  });

  it("gives every job type one ACTIVE version-1 completion form, varying by category (spec 8.6)", async () => {
    expect(result.completionForms).toBe(JOB_TYPES.length);
    await withTenant(tenantId, async (tx) => {
      const forms = await tx.jobCompletionFormDefinition.findMany({ include: { jobType: true } });
      expect(forms).toHaveLength(JOB_TYPES.length);
      for (const form of forms) expect(form).toMatchObject({ status: "ACTIVE", version: 1, category: null });
      const fieldsOf = (code: string) =>
        (forms.find((f) => f.jobType?.code === code)!.schema as { fields: { key: string; required: boolean }[] }).fields;
      const installation = fieldsOf("ac-install");
      const inspection = fieldsOf("seasonal-inspection");
      expect(installation.find((f) => f.key === "customerSignature")?.required).toBe(true);
      expect(inspection.some((f) => f.key === "customerSignature")).toBe(false); // not every job type uses identical fields
      expect(inspection.find((f) => f.key === "followUpRequired")?.required).toBe(true);
    });
  });

  it("creates ONE example recovery rule, inactive, high impact, that never offers a discount", async () => {
    expect(result.recoveryRules).toBe(1);
    await withTenant(tenantId, async (tx) => {
      const rules = await tx.recoveryRule.findMany();
      expect(rules).toHaveLength(1);
      const [rule] = rules;
      expect(rule).toMatchObject({ ruleKey: EXAMPLE_RECOVERY_RULE.ruleKey, status: "INACTIVE", highImpact: true, version: 1, trigger: "job.not_converted" });
      const reason = await tx.lostReason.findFirstOrThrow({ where: { code: "price-too-high" } });
      expect(rule.conditions).toMatchObject({ outcomes: ["NOT_SOLD"], lostReasonIds: [reason.id], presence: ["AT_LOCATION"] }); // ids, not names
      expect(JSON.stringify(rule.actions)).not.toMatch(/discount/i);
    });
  });

  it("is idempotent and tenant-scoped", async () => {
    const again = await seedFieldOperationsData(tenantId);
    expect(again).toEqual({ lostReasons: 0, completionForms: 0, recoveryRules: 0 });
    expect(await withTenant(tenantId, (tx) => tx.lostReason.count())).toBe(LOST_REASONS.length);
    // The other tenant has its own rows (same codes, different ids).
    await withTenant(otherTenantId, async (tx) => {
      expect(await tx.lostReason.count()).toBe(LOST_REASONS.length);
      expect(await tx.recoveryRule.count()).toBe(1);
    });
  });
});
