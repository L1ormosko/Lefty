import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth";
import { prisma, withTenant } from "@/server/db";
import { seedOperationalData, type SeedOperationsResult } from "../../prisma/seed/seed-operations";
import { CERTIFICATIONS, JOB_TYPES, LEAD_SOURCES, SKILLS, TECHNICIAN_PROFILES } from "../../prisma/seed/operations-specs";
import { seedTenant } from "../../prisma/seed/seed-tenant";
import { TENANT_SPECS } from "../../prisma/seed/tenant-specs";

const suffix = Math.random().toString(36).slice(2, 8);
const spec = { ...TENANT_SPECS[0], slug: `opsseed-a-${suffix}` };
const otherSpec = { ...TENANT_SPECS[1], slug: `opsseed-b-${suffix}` };
let tenantId: string;
let otherTenantId: string;
let result: SeedOperationsResult;

beforeAll(async () => {
  const passwordHash = await hashPassword("dev-seed-password-123");
  tenantId = (await seedTenant(spec, passwordHash)).tenantId;
  otherTenantId = (await seedTenant(otherSpec, passwordHash)).tenantId;
  result = await seedOperationalData(tenantId, spec.slug);
  await seedOperationalData(otherTenantId, otherSpec.slug);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("operational development seed", () => {
  it("creates the catalogs: skills, certifications, job types, lead sources and default settings", async () => {
    expect(result).toMatchObject({ created: true, skills: SKILLS.length, certifications: CERTIFICATIONS.length, jobTypes: JOB_TYPES.length, leadSources: LEAD_SOURCES.length });
    await withTenant(tenantId, async (tx) => {
      expect(await tx.skill.count()).toBe(SKILLS.length);
      expect(await tx.certification.count()).toBe(CERTIFICATIONS.length);
      expect(await tx.jobType.count()).toBe(JOB_TYPES.length);
      expect(await tx.leadSource.count()).toBe(LEAD_SOURCES.length);
      const settings = await tx.operationsSettings.findUniqueOrThrow({ where: { tenantId } });
      expect(settings).toMatchObject({ dispatchMode: "AI_ASSISTED", enabledChannels: ["IN_APP"] });
      // No customers, leads or jobs are seeded (they arrive with their modules).
      expect(await tx.customer.count()).toBe(0);
      expect(await tx.lead.count()).toBe(0);
      expect(await tx.job.count()).toBe(0);
    });
  });

  it("gives every job type its required skills and credentials", async () => {
    await withTenant(tenantId, async (tx) => {
      const installation = await tx.jobType.findFirstOrThrow({
        where: { code: "ac-install" },
        include: { skills: { include: { skill: true } }, certifications: { include: { certification: true } } },
      });
      expect(installation.category).toBe("installation");
      expect(installation.skills.map((s) => [s.skill.code, s.minLevel])).toEqual([["hvac-install", 3]]);
      expect(installation.certifications.map((c) => c.certification.code).sort()).toEqual(["epa-608", "recovery-machine", "tx-hvac-license"]);
      expect(installation.certifications.find((c) => c.certification.code === "recovery-machine")?.certification.type).toBe("EQUIPMENT");
      const inspection = await tx.jobType.findFirstOrThrow({ where: { code: "seasonal-inspection" } });
      expect(inspection.requiresReview).toBe(true);
    });
  });

  it("creates technicians with realistic, uneven qualifications and territories", async () => {
    await withTenant(tenantId, async (tx) => {
      const login = await tx.employee.findFirstOrThrow({ where: { email: `technician@${spec.slug}.example.test` } });
      const loginQualifications = await tx.employeeQualification.findMany({ where: { employeeId: login.id }, include: { skill: true, certification: true } });
      expect(loginQualifications.length).toBe(TECHNICIAN_PROFILES[0].qualifications.length);
      expect(loginQualifications.find((q) => q.skill?.code === "hvac-install")?.level).toBe(5);
      expect(await tx.serviceTerritory.count({ where: { employeeId: login.id } })).toBe(1);
      expect(await tx.availability.count({ where: { employeeId: login.id, kind: "WEEKLY_WINDOW" } })).toBe(5);

      // Extra technicians without a login, one set per team.
      const teams = await tx.orgUnit.count({ where: { type: "TEAM" } });
      const extra = await tx.employee.findMany({ where: { employeeNumber: { startsWith: "T-" } } });
      expect(extra).toHaveLength(teams * (TECHNICIAN_PROFILES.length - 1));
      expect(extra.every((e) => e.userId === null && e.status === "ACTIVE")).toBe(true);
      expect(result.technicians).toBe(1 + extra.length);

      const now = new Date();
      const expired = await tx.employeeQualification.findMany({ where: { expiresAt: { lt: now } } });
      const expiringSoon = await tx.employeeQualification.findMany({ where: { expiresAt: { gte: now, lt: new Date(Date.now() + 30 * 86_400_000) } } });
      const pending = await tx.employeeQualification.findMany({ where: { status: "PENDING_VERIFICATION" } });
      expect(expired.length).toBe(teams);
      expect(expiringSoon.length).toBe(teams);
      expect(pending.length).toBe(teams);
    });
  });

  it("gives branches coordinates and technicians job-category permissions", async () => {
    await withTenant(tenantId, async (tx) => {
      const branches = await tx.orgUnit.findMany({ where: { type: "BRANCH" } });
      expect(branches.length).toBeGreaterThan(0);
      expect(branches.every((b) => b.latitude !== null && b.longitude !== null)).toBe(true);
      const login = await tx.employee.findFirstOrThrow({ where: { email: `technician@${spec.slug}.example.test` } });
      const categories = (await tx.employeeJobPermission.findMany({ where: { employeeId: login.id } })).map((p) => p.category).sort();
      expect(categories).toEqual(["inspection", "installation", "repair"]);
    });
  });

  it("only verified qualifications carry a verifier, and licenses carry their number", async () => {
    await withTenant(tenantId, async (tx) => {
      const all = await tx.employeeQualification.findMany({ include: { certification: true } });
      for (const q of all) {
        expect(q.status === "VERIFIED" ? q.verifiedById !== null && q.verifiedAt !== null : q.verifiedById === null).toBe(true);
        if (q.certification?.type === "LICENSE") expect(q.number, q.certification.code).toBeTruthy();
      }
      const verifier = await tx.user.findFirstOrThrow({ where: { email: `hr@${spec.slug}.example.test` } });
      expect(all.find((q) => q.status === "VERIFIED")?.verifiedById).toBe(verifier.id);
    });
  });

  it("is idempotent and tenant-separated", async () => {
    const again = await seedOperationalData(tenantId, spec.slug);
    expect(again.created).toBe(false);
    expect(await withTenant(tenantId, (tx) => tx.skill.count())).toBe(SKILLS.length);
    // Globex has a single team, so fewer technicians than Acme; both have their own full catalogs.
    expect(await withTenant(otherTenantId, (tx) => tx.skill.count())).toBe(SKILLS.length);
    expect(await withTenant(otherTenantId, (tx) => tx.employee.count({ where: { employeeNumber: { startsWith: "T-" } } }))).toBe(TECHNICIAN_PROFILES.length - 1);
    expect(await withTenant(tenantId, (tx) => tx.skill.count({ where: { tenantId: otherTenantId } }))).toBe(0);
  });
});
