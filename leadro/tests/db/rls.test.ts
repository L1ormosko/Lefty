import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, withTenant } from "@/server/db";
import { createTenant } from "../helpers";

/** Every table with a "tenantId" column, by phase (Phase 1 (17), Phase 2 operational core (28 + 2 fix-round tables), Phase 3-7 below). */
const TENANT_OWNED_TABLES = [
  // Phase 1
  "LegalEntity", "OrgUnit", "Employee", "OrgUnitManager", "OrganizationalAssignment", "User", "Role", "RolePermission",
  "RoleAssignment", "AccessScope", "Session", "AuthenticationEvent", "Invitation", "PasswordResetToken", "AuditEvent",
  "IdempotencyRecord", "TranslationResource",
  // Phase 2
  "NumberSequence", "OperationsSettings", "Customer", "CustomerAddress", "CustomerNote", "LeadSource", "Lead",
  "LeadAssignment", "LeadStatusHistory", "LeadInteraction", "DuplicateFlag", "Skill", "Certification",
  "EmployeeQualification", "ServiceTerritory", "Availability", "JobType", "JobTypeSkill", "JobTypeCertification", "Job",
  "JobRequirement", "JobAssignment", "JobStatusHistory", "JobEvent", "DispatchRecommendation", "Notification",
  "NotificationDelivery", "NotificationPreference", "EmployeeJobPermission", "CustomerPreferredEmployee",
  // Phase 3 field operations and recovery (17)
  "Shift", "LocationEvent", "ArrivalVerification", "FieldEvent", "JobCompletionFormDefinition", "JobCompletion",
  "JobMaterialUsage", "JobFieldNote", "JobAttachment", "LostReason", "JobOutcome", "RecoveryRule", "LeadRecoveryCase",
  "RecoveryCaseStatusHistory", "RecoveryAttempt", "FollowUpTask", "RecoveryRuleRun",
  // Phase 4 financial core (13)
  "Material", "MaterialCostVersion", "LedgerEntry", "Payment", "Refund", "Chargeback", "Adjustment", "ApprovalPolicy",
  "ApprovalRequest", "ApprovalDecision", "ReconciliationRun", "ReconciliationException", "PaymentIntakeEvent",
  // Phase 4 follow-up migration 20261125100000_phase4_review_flags
  "FinanceReviewFlag",
  // Phase 5 workforce intelligence (14), migration 20261126100000_phase5_workforce
  "TrainingCourse", "TrainingAssignment", "TrainingRecord", "PerformanceMetricDefinition", "PerformanceMetricValue",
  "MetricContextNote", "CoachingRecord", "DevelopmentPlan", "DevelopmentGoal", "DevelopmentAction", "DevelopmentPlanReview",
  "TrainingRecommendation", "DataChallenge", "CustomerFeedback",
  // Phase 6 enterprise analytics (3), migration 20261127100000_phase6_analytics
  "SavedReportView", "SavedReportViewShare", "ReportExport",
  // Phase 7 integrations and automation (11), migration 20261128100000_phase7_integrations_automation. BackgroundJob and
  // ScheduledJobDefinition have a NULLABLE tenantId (system rows): tenant_isolation never matches NULL, so only the queue-worker
  // policy reaches them (tests/db/phase7-schema.test.ts).
  "BackgroundJob", "ScheduledJobDefinition", "DomainEventOutbox", "AutomationRule", "AutomationRuleVersion", "AutomationExecution",
  "Integration", "IntegrationLog", "WebhookEvent", "AccountingMapping", "ExportBatch",
];

let A: { id: string };
let B: { id: string };
let bLegalEntityId: string;
let bOrgUnitId: string;
let bUserId: string;

beforeAll(async () => {
  A = await createTenant("rls-a");
  B = await createTenant("rls-b");
  await withTenant(A.id, (tx) => tx.legalEntity.create({ data: { tenantId: A.id, name: "A Inc" } }));
  bLegalEntityId = (
    await withTenant(B.id, (tx) => tx.legalEntity.create({ data: { tenantId: B.id, name: "B Inc" } }))
  ).id;
  bOrgUnitId = (
    await withTenant(B.id, (tx) =>
      tx.orgUnit.create({ data: { tenantId: B.id, type: "STATE", name: "B State" } }),
    )
  ).id;
  bUserId = (
    await withTenant(B.id, (tx) =>
      tx.user.create({ data: { tenantId: B.id, email: "u@b.test", status: "ACTIVE" } }),
    )
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("database role", () => {
  it("is neither superuser nor BYPASSRLS", async () => {
    const [row] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });
});

describe("RLS coverage", () => {
  it("every table with a tenantId column has FORCE RLS and a tenant_isolation policy", async () => {
    const tables = await prisma.$queryRaw<
      { table_name: string; rls: boolean; forced: boolean; policies: bigint }[]
    >`
      SELECT c.table_name,
             cl.relrowsecurity AS rls,
             cl.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.table_name
                 AND p.policyname = 'tenant_isolation') AS policies
      FROM information_schema.columns c
      JOIN pg_class cl ON cl.relname = c.table_name AND cl.relnamespace = 'public'::regnamespace
      WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'`;
    // Sanity: the sweep found exactly the tenant-owned tables. A new tenant-owned table must be added here
    // on purpose (and the migration's RLS DO-block covers it automatically).
    expect(tables.map((t) => t.table_name).sort()).toEqual([...TENANT_OWNED_TABLES].sort());
    for (const t of tables) {
      expect(t.rls, `${t.table_name} RLS enabled`).toBe(true);
      expect(t.forced, `${t.table_name} RLS forced`).toBe(true);
      expect(Number(t.policies), `${t.table_name} policy`).toBe(1);
    }
  });

  it("only Tenant and Permission lack a tenantId column", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND t.table_name <> '_prisma_migrations'
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'tenantId')
      ORDER BY 1`;
    expect(rows.map((r) => r.table_name)).toEqual(["Permission", "Tenant"]);
  });
});

describe("tenant isolation via withTenant", () => {
  it("tenant A cannot see tenant B rows", async () => {
    const seen = await withTenant(A.id, (tx) => tx.legalEntity.findMany());
    expect(seen.map((r) => r.name)).toEqual(["A Inc"]);
    expect(await withTenant(A.id, (tx) => tx.legalEntity.findUnique({ where: { id: bLegalEntityId } }))).toBeNull();
    expect(await withTenant(A.id, (tx) => tx.orgUnit.count())).toBe(0);
    expect(await withTenant(A.id, (tx) => tx.user.count())).toBe(0);
  });

  it("tenant B still sees its own rows", async () => {
    expect(await withTenant(B.id, (tx) => tx.legalEntity.count())).toBe(1);
    expect(await withTenant(B.id, (tx) => tx.orgUnit.count())).toBe(1);
  });

  it("inserting a row with another tenant's id is rejected", async () => {
    await expect(
      withTenant(A.id, (tx) => tx.legalEntity.create({ data: { tenantId: B.id, name: "Smuggled" } })),
    ).rejects.toThrow();
    expect(await withTenant(B.id, (tx) => tx.legalEntity.count({ where: { name: "Smuggled" } }))).toBe(0);
  });

  it("update and delete cannot touch another tenant's rows", async () => {
    const upd = await withTenant(A.id, (tx) =>
      tx.legalEntity.updateMany({ where: { id: bLegalEntityId }, data: { name: "Hacked" } }),
    );
    const del = await withTenant(A.id, (tx) => tx.legalEntity.deleteMany({ where: { id: bLegalEntityId } }));
    expect(upd.count).toBe(0);
    expect(del.count).toBe(0);
    const still = await withTenant(B.id, (tx) => tx.legalEntity.findUnique({ where: { id: bLegalEntityId } }));
    expect(still?.name).toBe("B Inc");
  });

  it("a row cannot be moved to another tenant by update", async () => {
    await expect(
      withTenant(A.id, (tx) => tx.legalEntity.updateMany({ data: { tenantId: B.id } })),
    ).rejects.toThrow();
  });

  it("fails closed: no tenant context means no rows and no inserts", async () => {
    expect(await prisma.legalEntity.findMany()).toEqual([]);
    expect(await prisma.user.count()).toBe(0);
    await expect(prisma.legalEntity.create({ data: { tenantId: A.id, name: "No context" } })).rejects.toThrow();
  });

  it("tenant context does not leak between transactions", async () => {
    await withTenant(A.id, (tx) => tx.legalEntity.count());
    expect(await prisma.legalEntity.count()).toBe(0);
    const [row] = await prisma.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
    expect(row.v ?? "").toBe("");
  });

  it("rejects an empty tenant id", async () => {
    await expect(withTenant("", async () => 1)).rejects.toThrow(/tenantId/);
  });
});

describe("composite foreign keys keep references inside one tenant", () => {
  it("an OrgUnit of A cannot have a parent in B", async () => {
    await expect(
      withTenant(A.id, (tx) =>
        tx.orgUnit.create({ data: { tenantId: A.id, type: "CITY", name: "X", parentId: bOrgUnitId } }),
      ),
    ).rejects.toThrow();
  });

  it("an Employee of A cannot be linked to a User or legal entity of B", async () => {
    await expect(
      withTenant(A.id, (tx) =>
        tx.employee.create({ data: { tenantId: A.id, firstName: "x", lastName: "y", userId: bUserId } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(A.id, (tx) =>
        tx.employee.create({
          data: { tenantId: A.id, firstName: "x", lastName: "y", legalEntityId: bLegalEntityId },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("AuditEvent is append-only", () => {
  it("allows insert and read, rejects UPDATE, DELETE and TRUNCATE", async () => {
    const ev = await withTenant(A.id, (tx) =>
      tx.auditEvent.create({
        data: { tenantId: A.id, action: "test.created", targetType: "Thing", targetId: "1", correlationId: "c-1" },
      }),
    );
    expect(await withTenant(A.id, (tx) => tx.auditEvent.count({ where: { id: ev.id } }))).toBe(1);

    await expect(
      withTenant(A.id, (tx) => tx.auditEvent.update({ where: { id: ev.id }, data: { action: "tampered" } })),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTenant(A.id, (tx) => tx.auditEvent.delete({ where: { id: ev.id } })),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTenant(A.id, (tx) => tx.$executeRawUnsafe(`UPDATE "AuditEvent" SET "action" = 'x'`)),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AuditEvent"`)).rejects.toThrow(/append-only/);

    const after = await withTenant(A.id, (tx) => tx.auditEvent.findUnique({ where: { id: ev.id } }));
    expect(after?.action).toBe("test.created");
  });

  it("tenant B cannot read tenant A's audit events", async () => {
    expect(await withTenant(B.id, (tx) => tx.auditEvent.count({ where: { action: "test.created" } }))).toBe(0);
  });
});

describe("integrity constraints", () => {
  it("an OrgUnit cannot be its own parent", async () => {
    await expect(
      withTenant(A.id, (tx) =>
        tx.orgUnit.create({ data: { id: "self-parent", tenantId: A.id, type: "STATE", name: "Self", parentId: "self-parent" } }),
      ),
    ).rejects.toThrow(/org_unit_not_own_parent/);
    // Updating an existing unit to point at itself is also refused (by the cycle guard or the CHECK).
    const u = await withTenant(A.id, (tx) =>
      tx.orgUnit.create({ data: { tenantId: A.id, type: "STATE", name: "Self2" } }),
    );
    await expect(
      withTenant(A.id, (tx) => tx.orgUnit.update({ where: { id: u.id }, data: { parentId: u.id } })),
    ).rejects.toThrow(/cycle|org_unit_not_own_parent/);
  });

  it("an OrgUnit hierarchy cycle is rejected", async () => {
    const [p, c] = await withTenant(A.id, async (tx) => {
      const p = await tx.orgUnit.create({ data: { tenantId: A.id, type: "REGION", name: "P" } });
      const c = await tx.orgUnit.create({ data: { tenantId: A.id, type: "CITY", name: "C", parentId: p.id } });
      return [p, c];
    });
    await expect(
      withTenant(A.id, (tx) => tx.orgUnit.update({ where: { id: p.id }, data: { parentId: c.id } })),
    ).rejects.toThrow(/cycle/);
  });

  it("an employee cannot have overlapping PRIMARY assignments but may have a TEMPORARY one", async () => {
    await withTenant(A.id, async (tx) => {
      const unit1 = await tx.orgUnit.create({ data: { tenantId: A.id, type: "TEAM", name: "T1" } });
      const unit2 = await tx.orgUnit.create({ data: { tenantId: A.id, type: "TEAM", name: "T2" } });
      const emp = await tx.employee.create({ data: { tenantId: A.id, firstName: "E", lastName: "M" } });
      await tx.organizationalAssignment.create({
        data: { tenantId: A.id, employeeId: emp.id, orgUnitId: unit1.id, effectiveFrom: new Date("2026-01-01") },
      });
      // Temporary placement elsewhere without changing the primary one is allowed.
      await tx.organizationalAssignment.create({
        data: { tenantId: A.id, employeeId: emp.id, orgUnitId: unit2.id, kind: "TEMPORARY", effectiveFrom: new Date("2026-02-01") },
      });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(
        tx.organizationalAssignment.create({
          data: { tenantId: A.id, employeeId: emp.id, orgUnitId: unit2.id, effectiveFrom: new Date("2026-03-01") },
        }),
      ).rejects.toThrow();
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
    });
  });

  it("AccessScope target must match its type", async () => {
    await withTenant(A.id, async (tx) => {
      const user = await tx.user.create({ data: { tenantId: A.id, email: "scope@a.test" } });
      const role = await tx.role.create({ data: { tenantId: A.id, name: "R-scope" } });
      const ra = await tx.roleAssignment.create({ data: { tenantId: A.id, userId: user.id, roleId: role.id } });
      await tx.accessScope.create({ data: { tenantId: A.id, roleAssignmentId: ra.id, type: "TENANT" } });
      await tx.$executeRaw`SAVEPOINT s2`;
      await expect(
        tx.accessScope.create({ data: { tenantId: A.id, roleAssignmentId: ra.id, type: "ORG_UNIT" } }),
      ).rejects.toThrow();
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s2`;
    });
  });

  it("emails must be lower-case and unique per tenant, not globally", async () => {
    await expect(
      withTenant(A.id, (tx) => tx.user.create({ data: { tenantId: A.id, email: "Mixed@A.test" } })),
    ).rejects.toThrow();
    await withTenant(A.id, (tx) => tx.user.create({ data: { tenantId: A.id, email: "same@x.test" } }));
    await withTenant(B.id, (tx) => tx.user.create({ data: { tenantId: B.id, email: "same@x.test" } }));
    await expect(
      withTenant(A.id, (tx) => tx.user.create({ data: { tenantId: A.id, email: "same@x.test" } })),
    ).rejects.toThrow();
  });

  it("unsupported locales are rejected", async () => {
    await expect(
      withTenant(A.id, (tx) => tx.user.create({ data: { tenantId: A.id, email: "loc@a.test", locale: "fr-FR" } })),
    ).rejects.toThrow();
  });
});
