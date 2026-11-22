import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUSTOMER_FIELD_MAP, JOB_FIELD_MAP, LEAD_FIELD_MAP } from "@/server/authz";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { createTenant } from "../helpers";

/**
 * Phase 2 schema: tenant isolation of every new table, composite tenant-safe foreign keys, CHECK
 * constraints, partial unique indexes and append-only history. Constraint names asserted here are
 * part of the migration contract (20261122121345_phase2_operational_core).
 */

interface Graph {
  tenantId: string;
  userId: string;
  employeeId: string;
  orgUnitId: string;
  customerId: string;
  otherCustomerId: string;
  addressId: string;
  otherCustomerAddressId: string;
  sourceId: string;
  leadId: string;
  otherLeadId: string;
  skillId: string;
  certificationId: string;
  jobTypeId: string;
  jobId: string;
  jobAssignmentId: string;
  recommendationId: string;
  notificationId: string;
}

const suffix = Math.random().toString(36).slice(2, 7);
let A: Graph;
let B: Graph;

/** One row in (nearly) every Phase 2 table, so isolation can be asserted table by table. */
async function buildGraph(label: string): Promise<Graph> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;
  return withTenant(tenantId, async (tx) => {
    const orgUnit = await tx.orgUnit.create({ data: { tenantId, type: "BRANCH", name: `Branch ${label}` } });
    const user = await tx.user.create({ data: { tenantId, email: `u-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const employee = await tx.employee.create({ data: { tenantId, userId: user.id, firstName: "Tech", lastName: label } });
    const customer = await tx.customer.create({
      data: { tenantId, number: 1, name: "Ann Customer", email: "ann@x.test", phone: "(555) 010-0001", phoneE164: "+15550100001", preferredLocale: "es-US", orgUnitId: orgUnit.id },
    });
    const otherCustomer = await tx.customer.create({ data: { tenantId, number: 2, name: "Bob Customer" } });
    const address = await tx.customerAddress.create({
      data: { tenantId, customerId: customer.id, line1: "1 Main St", city: "Dallas", region: "TX", postalCode: "75201", normalizedKey: "1 main st||dallas|tx|75201|us", latitude: "32.776700", longitude: "-96.797000", orgUnitId: orgUnit.id },
    });
    const otherAddress = await tx.customerAddress.create({
      data: { tenantId, customerId: otherCustomer.id, line1: "2 Main St", city: "Dallas", region: "TX", postalCode: "75201", normalizedKey: "2 main st||dallas|tx|75201|us" },
    });
    await tx.customerNote.create({ data: { tenantId, customerId: customer.id, authorId: user.id, body: "Prefers mornings" } });
    const source = await tx.leadSource.create({ data: { tenantId, code: "website", name: "Website", type: "WEBSITE" } });
    const skill = await tx.skill.create({ data: { tenantId, code: "hvac-install", name: "HVAC installation" } });
    const certification = await tx.certification.create({ data: { tenantId, code: "epa-608", name: "EPA 608", type: "LICENSE", validityMonths: 60, requiresNumber: true } });
    const jobType = await tx.jobType.create({
      data: { tenantId, code: "ac-install", name: "AC installation", category: "installation", defaultDurationMinutes: 180, requiredEquipment: ["ladder"], completionFormSchema: { sections: [] } },
    });
    await tx.jobTypeSkill.create({ data: { tenantId, jobTypeId: jobType.id, skillId: skill.id, minLevel: 3 } });
    await tx.jobTypeCertification.create({ data: { tenantId, jobTypeId: jobType.id, certificationId: certification.id } });
    const lead = await tx.lead.create({
      data: { tenantId, number: 1, sourceId: source.id, externalId: "ext-1", customerId: customer.id, customerAddressId: address.id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, contactEmail: "ann@x.test", quotedAmountMinor: 450000 },
    });
    const otherLead = await tx.lead.create({ data: { tenantId, number: 2, contactName: "Dup Lead", contactPhoneE164: "+15550100001" } });
    await tx.leadAssignment.create({ data: { tenantId, leadId: lead.id, employeeId: employee.id, assignedById: user.id } });
    await tx.leadStatusHistory.create({ data: { tenantId, leadId: lead.id, toStatus: "NEW", actorUserId: user.id } });
    await tx.leadInteraction.create({ data: { tenantId, leadId: lead.id, kind: "CONTACT_ATTEMPT", channel: "PHONE", outcome: "NO_ANSWER", authorId: user.id } });
    const [leadA, leadB] = [lead.id, otherLead.id].sort();
    await tx.duplicateFlag.create({
      data: { tenantId, kind: "LEAD_LEAD", pairKey: `LEAD_LEAD:${leadA}:${leadB}`, leadId: leadA, otherLeadId: leadB, matchedOn: ["PHONE"], reason: "same phone" },
    });
    await tx.employeeQualification.create({
      data: { tenantId, employeeId: employee.id, kind: "SKILL", skillId: skill.id, level: 4, status: "VERIFIED", verifiedById: user.id, verifiedAt: new Date() },
    });
    await tx.serviceTerritory.create({ data: { tenantId, employeeId: employee.id, orgUnitId: orgUnit.id } });
    await tx.availability.create({
      data: { tenantId, employeeId: employee.id, kind: "WEEKLY_WINDOW", timeZone: "America/Chicago", isoDayOfWeek: 1, startMinute: 480, endMinute: 1020 },
    });
    const job = await tx.job.create({
      data: {
        tenantId, number: 1, customerId: customer.id, serviceAddressId: address.id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, leadId: lead.id,
        title: "Install AC", estimatedDurationMinutes: 180, quotedAmountMinor: 450000,
        appointmentWindowStart: new Date("2026-12-01T14:00:00Z"), appointmentWindowEnd: new Date("2026-12-01T18:00:00Z"),
      },
    });
    await tx.jobRequirement.create({ data: { tenantId, jobId: job.id, skillId: skill.id, minLevel: 3 } });
    const recommendation = await tx.dispatchRecommendation.create({
      data: { tenantId, jobId: job.id, mode: "AI_ASSISTED", candidates: [], blockingReasons: { none: true } },
    });
    const assignment = await tx.jobAssignment.create({ data: { tenantId, jobId: job.id, employeeId: employee.id, assignedById: user.id } });
    await tx.jobStatusHistory.create({ data: { tenantId, jobId: job.id, toStatus: "CREATED", actorUserId: user.id } });
    await tx.jobEvent.create({ data: { tenantId, jobId: job.id, type: "job.created", actorUserId: user.id, clientEventId: "c-1" } });
    const notification = await tx.notification.create({
      data: { tenantId, recipientId: user.id, eventType: "job.assigned", eventId: `job:${job.id}`, idempotencyKey: `job.assigned:${job.id}`, templateKey: "NOTIFICATION.JOB_ASSIGNED", targetType: "job", targetId: job.id },
    });
    await tx.notificationDelivery.create({ data: { tenantId, notificationId: notification.id, channel: "IN_APP", status: "DELIVERED" } });
    await tx.notificationPreference.create({ data: { tenantId, userId: user.id, eventType: "*", channel: "EMAIL", enabled: false } });
    await tx.numberSequence.create({ data: { tenantId, name: "job", lastValue: 1 } });
    await tx.operationsSettings.create({ data: { tenantId, updatedById: user.id } });
    await tx.employeeJobPermission.create({ data: { tenantId, employeeId: employee.id, category: "installation", grantedById: user.id } });
    await tx.customerPreferredEmployee.create({ data: { tenantId, customerId: customer.id, employeeId: employee.id } });
    return {
      tenantId, userId: user.id, employeeId: employee.id, orgUnitId: orgUnit.id, customerId: customer.id, otherCustomerId: otherCustomer.id,
      addressId: address.id, otherCustomerAddressId: otherAddress.id, sourceId: source.id, leadId: lead.id, otherLeadId: otherLead.id, skillId: skill.id,
      certificationId: certification.id, jobTypeId: jobType.id, jobId: job.id, jobAssignmentId: assignment.id, recommendationId: recommendation.id, notificationId: notification.id,
    };
  });
}

beforeAll(async () => {
  A = await buildGraph("p2a");
  B = await buildGraph("p2b");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** Runs `fn` in its own transaction for tenant `g` and expects the database to reject it, naming `rule`. */
const rejects = (g: Graph, rule: RegExp | string, fn: (tx: TenantTx) => Promise<unknown>) =>
  expect(withTenant(g.tenantId, fn)).rejects.toThrow(rule);

describe("tenant isolation of every Phase 2 table", () => {
  const TABLES = [
    "Customer", "CustomerAddress", "CustomerNote", "LeadSource", "Lead", "LeadAssignment", "LeadStatusHistory",
    "LeadInteraction", "DuplicateFlag", "Skill", "Certification", "EmployeeQualification", "ServiceTerritory",
    "Availability", "JobType", "JobTypeSkill", "JobTypeCertification", "Job", "JobRequirement", "JobAssignment",
    "JobStatusHistory", "JobEvent", "DispatchRecommendation", "Notification", "NotificationDelivery",
    "NotificationPreference", "NumberSequence", "OperationsSettings", "EmployeeJobPermission", "CustomerPreferredEmployee",
  ];

  it.each(TABLES)("%s: each tenant sees only its own rows, and nothing without a tenant context", async (table) => {
    const own = async (g: Graph) =>
      withTenant(g.tenantId, async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ tenantId: string }[]>(`SELECT "tenantId" FROM "${table}"`);
        return rows.map((r) => r.tenantId);
      });
    const seenByA = await own(A);
    const seenByB = await own(B);
    expect(seenByA.length).toBeGreaterThan(0);
    expect(new Set(seenByA)).toEqual(new Set([A.tenantId]));
    expect(new Set(seenByB)).toEqual(new Set([B.tenantId]));
    const noContext = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`);
    expect(noContext).toEqual([]);
  });

  it("a tenant cannot insert a Phase 2 row under another tenant's id", async () => {
    await rejects(A, /row-level security/, (tx) => tx.customer.create({ data: { tenantId: B.tenantId, number: 99, name: "Smuggled" } }));
    await rejects(A, /row-level security/, (tx) => tx.notification.create({ data: { tenantId: B.tenantId, recipientId: B.userId, eventType: "x.y", eventId: "e", idempotencyKey: "k", templateKey: "T" } }));
  });
});

describe("composite foreign keys keep every reference inside one tenant", () => {
  it("a job cannot point at another tenant's customer, address, job type or org unit", async () => {
    const base = { number: 50, title: "x", estimatedDurationMinutes: 60 };
    await rejects(A, /foreign key/i, (tx) => tx.job.create({ data: { ...base, tenantId: A.tenantId, customerId: B.customerId, serviceAddressId: A.addressId, jobTypeId: A.jobTypeId, orgUnitId: A.orgUnitId } }));
    await rejects(A, /foreign key/i, (tx) => tx.job.create({ data: { ...base, tenantId: A.tenantId, customerId: A.customerId, serviceAddressId: A.addressId, jobTypeId: B.jobTypeId, orgUnitId: A.orgUnitId } }));
    await rejects(A, /foreign key/i, (tx) => tx.job.create({ data: { ...base, tenantId: A.tenantId, customerId: A.customerId, serviceAddressId: A.addressId, jobTypeId: A.jobTypeId, orgUnitId: B.orgUnitId } }));
  });

  it("a job's service address must belong to the job's own customer", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.job.create({ data: { tenantId: A.tenantId, number: 51, title: "x", estimatedDurationMinutes: 60, customerId: A.customerId, serviceAddressId: A.otherCustomerAddressId, jobTypeId: A.jobTypeId, orgUnitId: A.orgUnitId } }),
    );
  });

  it("a lead's address must belong to its customer, and cannot reference another tenant's source", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.lead.create({ data: { tenantId: A.tenantId, number: 52, customerId: A.otherCustomerId, customerAddressId: A.addressId } }));
    await rejects(A, /foreign key/i, (tx) => tx.lead.create({ data: { tenantId: A.tenantId, number: 53, sourceId: B.sourceId } }));
    await rejects(A, /lead_address_needs_customer/, (tx) => tx.lead.create({ data: { tenantId: A.tenantId, number: 54, customerAddressId: A.addressId } }));
  });

  it("assignments, qualifications, notifications and territories cannot cross tenants", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.jobAssignment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: B.employeeId, role: "CREW" } }));
    await rejects(A, /foreign key/i, (tx) => tx.leadAssignment.create({ data: { tenantId: A.tenantId, leadId: B.leadId, employeeId: A.employeeId } }));
    await rejects(A, /foreign key/i, (tx) => tx.employeeQualification.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "SKILL", skillId: B.skillId } }));
    await rejects(A, /foreign key/i, (tx) => tx.serviceTerritory.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, orgUnitId: B.orgUnitId } }));
    await rejects(A, /foreign key/i, (tx) => tx.notification.create({ data: { tenantId: A.tenantId, recipientId: B.userId, eventType: "job.assigned", eventId: "e", idempotencyKey: "k-cross", templateKey: "T" } }));
    await rejects(A, /foreign key/i, (tx) => tx.jobTypeSkill.create({ data: { tenantId: A.tenantId, jobTypeId: A.jobTypeId, skillId: B.skillId } }));
  });
});

describe("CHECK constraints", () => {
  const addr = (g: Graph, data: Partial<Prisma.CustomerAddressUncheckedCreateInput>) => (tx: TenantTx) =>
    tx.customerAddress.create({ data: { tenantId: g.tenantId, customerId: g.customerId, line1: "x", city: "c", region: "r", postalCode: "1", normalizedKey: `k-${Math.random()}`, ...data } });

  it("customer address coordinates are within range and come as a pair", async () => {
    await rejects(A, /customer_address_latitude_range/, addr(A, { latitude: "90.5", longitude: "10" }));
    await rejects(A, /customer_address_longitude_range/, addr(A, { latitude: "10", longitude: "-180.5" }));
    await rejects(A, /customer_address_coordinates_pair/, addr(A, { latitude: "10" }));
    await rejects(A, /customer_address_country_format/, addr(A, { countryCode: "us" }));
    await expect(withTenant(A.tenantId, addr(A, {}))).resolves.toBeDefined(); // no coordinates at all is fine
  });

  it("customers: lower-case email, E.164 phone, supported locale, positive number", async () => {
    const create = (data: Partial<Prisma.CustomerUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.customer.create({ data: { tenantId: A.tenantId, number: 200 + Math.floor(Math.random() * 1e6), name: "n", ...data } });
    await rejects(A, /customer_email_lowercase/, create({ email: "Mixed@X.test" }));
    await rejects(A, /customer_phone_e164/, create({ phoneE164: "555-0100" }));
    await rejects(A, /customer_locale_supported/, create({ preferredLocale: "fr-FR" }));
    await rejects(A, /customer_number_positive/, create({ number: 0 }));
    await rejects(A, /Unique constraint|unique/i, create({ number: 1 }));
  });

  it("money is non-negative minor units with an ISO-shaped currency", async () => {
    await rejects(A, /lead_amount_non_negative/, (tx) => tx.lead.update({ where: { id: A.leadId }, data: { quotedAmountMinor: -1 } }));
    await rejects(A, /job_amount_non_negative/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { quotedAmountMinor: -5 } }));
    await rejects(A, /lead_currency_format/, (tx) => tx.lead.update({ where: { id: A.leadId }, data: { currency: "usd" } }));
    await rejects(A, /job_currency_format/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { currency: "US" } }));
    await expect(withTenant(A.tenantId, (tx) => tx.job.update({ where: { id: A.jobId }, data: { quotedAmountMinor: 0, currency: "EUR" } }))).resolves.toBeDefined();
  });

  it("job appointment window and scheduled slot: both or neither, end after start", async () => {
    const t = (iso: string) => new Date(iso);
    await rejects(A, /job_appointment_window/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { appointmentWindowEnd: t("2026-12-01T13:00:00Z") } }));
    await rejects(A, /job_appointment_window/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { appointmentWindowStart: null } }));
    await rejects(A, /job_scheduled_slot/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { scheduledStartAt: t("2026-12-01T15:00:00Z") } }));
    await rejects(A, /job_scheduled_slot/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { scheduledStartAt: t("2026-12-01T15:00:00Z"), scheduledEndAt: t("2026-12-01T15:00:00Z") } }));
    await rejects(A, /job_duration_range/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { estimatedDurationMinutes: 0 } }));
    await rejects(A, /job_not_own_parent/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { parentJobId: A.jobId } }));
    await expect(
      withTenant(A.tenantId, (tx) => tx.job.update({ where: { id: A.jobId }, data: { scheduledStartAt: t("2026-12-01T15:00:00Z"), scheduledEndAt: t("2026-12-01T18:00:00Z") } })),
    ).resolves.toBeDefined();
  });

  it("job types, lead preferred windows and identifier formats", async () => {
    await rejects(A, /job_type_duration_range/, (tx) => tx.jobType.create({ data: { tenantId: A.tenantId, code: "bad-duration", name: "x", category: "c", defaultDurationMinutes: 0 } }));
    await rejects(A, /job_type_code_format/, (tx) => tx.jobType.create({ data: { tenantId: A.tenantId, code: "Bad Code", name: "x", category: "c", defaultDurationMinutes: 30 } }));
    await rejects(A, /skill_code_format/, (tx) => tx.skill.create({ data: { tenantId: A.tenantId, code: "UPPER", name: "x" } }));
    await rejects(A, /lead_source_code_format/, (tx) => tx.leadSource.create({ data: { tenantId: A.tenantId, code: "has space", name: "x", type: "API" } }));
    await rejects(A, /lead_preferred_window_order/, (tx) =>
      tx.lead.update({ where: { id: A.leadId }, data: { preferredWindowStart: new Date("2026-12-02T10:00:00Z"), preferredWindowEnd: new Date("2026-12-02T09:00:00Z") } }),
    );
    await rejects(A, /lead_email_lowercase/, (tx) => tx.lead.update({ where: { id: A.leadId }, data: { contactEmail: "A@X.test" } }));
    await rejects(A, /lead_phone_e164/, (tx) => tx.lead.update({ where: { id: A.leadId }, data: { contactPhoneE164: "123" } }));
    await rejects(A, /lead_not_own_duplicate/, (tx) => tx.lead.update({ where: { id: A.leadId }, data: { duplicateOfLeadId: A.leadId } }));
  });

  it("credentials: SKILL vs certification columns, level range, dates and verification", async () => {
    const q = (data: Partial<Prisma.EmployeeQualificationUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.employeeQualification.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "LICENSE", certificationId: A.certificationId, ...data } });
    await rejects(A, /employee_qualification_target/, q({ kind: "SKILL" }));
    await rejects(A, /employee_qualification_target/, q({ skillId: A.skillId }));
    await rejects(A, /employee_qualification_level/, q({ level: 3 }));
    await rejects(A, /employee_qualification_level/, (tx) => tx.employeeQualification.updateMany({ where: { skillId: A.skillId }, data: { level: 6 } }));
    await rejects(A, /employee_qualification_dates/, q({ issuedAt: new Date("2026-01-10"), expiresAt: new Date("2026-01-10") }));
    await rejects(A, /employee_qualification_verified/, q({ status: "VERIFIED" }));
    await rejects(A, /certification_not_skill/, (tx) => tx.certification.create({ data: { tenantId: A.tenantId, code: "oops", name: "x", type: "SKILL" } }));
    await rejects(A, /certification_validity_positive/, (tx) => tx.certification.create({ data: { tenantId: A.tenantId, code: "oops2", name: "x", validityMonths: 0 } }));
    await expect(withTenant(A.tenantId, q({ issuedAt: new Date("2026-01-10"), expiresAt: new Date("2027-01-10"), number: "TX-1" }))).resolves.toBeDefined();
  });

  it("availability keeps weekly windows and exceptions apart", async () => {
    const av = (data: Partial<Prisma.AvailabilityUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.availability.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "WEEKLY_WINDOW", timeZone: "America/Chicago", isoDayOfWeek: 2, startMinute: 60, endMinute: 120, ...data } });
    await rejects(A, /availability_shape/, av({ isoDayOfWeek: 8 }));
    await rejects(A, /availability_shape/, av({ startMinute: 120, endMinute: 120 }));
    await rejects(A, /availability_shape/, av({ endMinute: 1441 }));
    await rejects(A, /availability_shape/, av({ startsAt: new Date("2026-12-01T00:00:00Z") }));
    await rejects(A, /availability_shape/, av({ kind: "EXCEPTION_UNAVAILABLE" })); // exception without an interval
    await rejects(A, /availability_shape/, av({ kind: "EXCEPTION_UNAVAILABLE", isoDayOfWeek: null, startMinute: null, endMinute: null, startsAt: new Date("2026-12-02T00:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") }));
    await rejects(A, /availability_valid_dates/, av({ validFrom: new Date("2026-03-01"), validTo: new Date("2026-02-01") }));
    await expect(
      withTenant(A.tenantId, av({ kind: "EXCEPTION_UNAVAILABLE", isoDayOfWeek: null, startMinute: null, endMinute: null, startsAt: new Date("2026-12-01T00:00:00Z"), endsAt: new Date("2026-12-03T00:00:00Z"), note: "time off" })),
    ).resolves.toBeDefined();
  });

  it("job assignments: one target, ended state consistent, override needs a reason, recommendation link", async () => {
    const ja = (data: Partial<Prisma.JobAssignmentUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.jobAssignment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, role: "CREW", employeeId: null, ...data } });
    await rejects(A, /job_assignment_target/, ja({}));
    await rejects(A, /job_assignment_target/, ja({ employeeId: A.employeeId, teamOrgUnitId: A.orgUnitId }));
    await rejects(A, /job_assignment_state_ended/, ja({ teamOrgUnitId: A.orgUnitId, state: "ENDED" }));
    await rejects(A, /job_assignment_override_reason/, ja({ teamOrgUnitId: A.orgUnitId, method: "OVERRIDE", overrideReason: "  " }));
    await rejects(A, /job_assignment_recommendation_link/, ja({ teamOrgUnitId: A.orgUnitId, method: "RECOMMENDATION_APPROVED" }));
    await expect(withTenant(A.tenantId, ja({ teamOrgUnitId: A.orgUnitId, method: "OVERRIDE", overrideReason: "Customer asked for this crew", recommendationId: A.recommendationId }))).resolves.toBeDefined();
  });

  it("dispatch recommendations record who decided; duplicate flags keep their shape", async () => {
    await rejects(A, /dispatch_recommendation_decision/, (tx) => tx.dispatchRecommendation.create({ data: { tenantId: A.tenantId, jobId: A.jobId, mode: "MANUAL", candidates: [], status: "APPROVED" } }));
    const [low, high] = [A.leadId, A.otherLeadId].sort();
    const flag = (data: Partial<Prisma.DuplicateFlagUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.duplicateFlag.create({ data: { tenantId: A.tenantId, kind: "LEAD_LEAD", pairKey: `k-${Math.random()}`, leadId: low, otherLeadId: high, ...data } });
    await rejects(A, /duplicate_flag_shape/, flag({ leadId: high, otherLeadId: low })); // not in sorted order
    await rejects(A, /duplicate_flag_shape/, flag({ customerId: A.customerId }));
    await rejects(A, /duplicate_flag_shape/, flag({ kind: "CUSTOMER_CUSTOMER" }));
    await rejects(A, /duplicate_flag_resolution/, flag({ status: "NOT_DUPLICATE" }));
    await rejects(A, /Unique constraint|unique/i, flag({ pairKey: `LEAD_LEAD:${low}:${high}` }));
    await expect(withTenant(A.tenantId, flag({ kind: "LEAD_CUSTOMER", leadId: A.leadId, otherLeadId: null, customerId: A.customerId, status: "NOT_DUPLICATE", resolvedAt: new Date(), resolvedById: A.userId }))).resolves.toBeDefined();
  });

  it("notifications: dotted event types, delivery attempts, failure reasons and retry times", async () => {
    await rejects(A, /notification_event_type_format/, (tx) => tx.notification.create({ data: { tenantId: A.tenantId, recipientId: A.userId, eventType: "Job Assigned", eventId: "e", idempotencyKey: "k1", templateKey: "T" } }));
    await rejects(A, /notification_target_pair/, (tx) => tx.notification.create({ data: { tenantId: A.tenantId, recipientId: A.userId, eventType: "job.x", eventId: "e", idempotencyKey: "k2", templateKey: "T", targetType: "job" } }));
    await rejects(A, /notification_preference_event_type_format/, (tx) => tx.notificationPreference.create({ data: { tenantId: A.tenantId, userId: A.userId, eventType: "BAD", channel: "SMS" } }));
    const d = (data: Partial<Prisma.NotificationDeliveryUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.notificationDelivery.create({ data: { tenantId: A.tenantId, notificationId: A.notificationId, channel: "EMAIL", ...data } });
    await rejects(A, /notification_delivery_attempt_positive/, d({ attempt: 0 }));
    await rejects(A, /notification_delivery_failure_reason/, d({ status: "FAILED" }));
    await rejects(A, /notification_delivery_retry_time/, d({ status: "FAILED", failureReason: "timeout", retryStatus: "SCHEDULED" }));
    await expect(withTenant(A.tenantId, d({ status: "FAILED", failureReason: "provider timeout", retryStatus: "SCHEDULED", nextRetryAt: new Date(Date.now() + 60_000), attempt: 1 }))).resolves.toBeDefined();
    await expect(withTenant(A.tenantId, d({ status: "NOT_CONFIGURED", attempt: 2 }))).resolves.toBeDefined();
    await rejects(A, /Unique constraint|unique/i, d({ attempt: 2 })); // one row per (notification, channel, attempt)
  });

  it("job events use dotted types and operations settings stay positive", async () => {
    await rejects(A, /job_event_type_format/, (tx) => tx.jobEvent.create({ data: { tenantId: A.tenantId, jobId: A.jobId, type: "JobCreated" } }));
    await rejects(A, /operations_settings_positive/, (tx) => tx.operationsSettings.update({ where: { tenantId: A.tenantId }, data: { contactAttemptOpenMinutes: 0 } }));
    await rejects(A, /operations_settings_currency_format/, (tx) => tx.operationsSettings.update({ where: { tenantId: A.tenantId }, data: { defaultCurrency: "us" } }));
    await rejects(A, /number_sequence_non_negative/, (tx) => tx.numberSequence.update({ where: { tenantId_name: { tenantId: A.tenantId, name: "job" } }, data: { lastValue: -1 } }));
  });

  it("status history rows must change the status", async () => {
    await rejects(A, /lead_status_history_changed/, (tx) => tx.leadStatusHistory.create({ data: { tenantId: A.tenantId, leadId: A.leadId, fromStatus: "NEW", toStatus: "NEW" } }));
    await rejects(A, /job_status_history_changed/, (tx) => tx.jobStatusHistory.create({ data: { tenantId: A.tenantId, jobId: A.jobId, fromStatus: "CREATED", toStatus: "CREATED" } }));
  });
});

describe("uniqueness and partial unique indexes", () => {
  it("a lead has one ACTIVE owner at a time; ended rows are history", async () => {
    await rejects(A, /LeadAssignment_one_active_per_lead|unique/i, (tx) => tx.leadAssignment.create({ data: { tenantId: A.tenantId, leadId: A.leadId, employeeId: A.employeeId } }));
    await withTenant(A.tenantId, async (tx) => {
      await tx.leadAssignment.updateMany({ where: { leadId: A.leadId, state: "ACTIVE" }, data: { state: "ENDED", endedAt: new Date(), endedReason: "reassigned" } });
      await tx.leadAssignment.create({ data: { tenantId: A.tenantId, leadId: A.leadId, employeeId: A.employeeId } });
    });
    expect(await withTenant(A.tenantId, (tx) => tx.leadAssignment.count({ where: { leadId: A.leadId } }))).toBe(2);
  });

  it("a job has one ACTIVE lead assignee, crew members are unique per job", async () => {
    await rejects(A, /JobAssignment_one_active_lead_per_job|unique/i, (tx) => tx.jobAssignment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, teamOrgUnitId: A.orgUnitId, role: "LEAD" } }));
    const crew = await withTenant(A.tenantId, async (tx) => {
      const mate = await tx.employee.create({ data: { tenantId: A.tenantId, firstName: "Crew", lastName: "Mate" } });
      await tx.jobAssignment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: mate.id, role: "CREW" } });
      return mate.id;
    });
    await rejects(A, /JobAssignment_one_active_per_job_employee|unique/i, (tx) => tx.jobAssignment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: crew, role: "CREW" } }));
  });

  it("other natural keys: external lead id per source, job event client id, number sequence, one skill per employee, one job per lead", async () => {
    await rejects(A, /unique/i, (tx) => tx.lead.create({ data: { tenantId: A.tenantId, number: 77, sourceId: A.sourceId, externalId: "ext-1" } }));
    await expect(withTenant(A.tenantId, (tx) => tx.lead.create({ data: { tenantId: A.tenantId, number: 78, externalId: "ext-1" } }))).resolves.toBeDefined(); // another (null) source
    await rejects(A, /unique/i, (tx) => tx.jobEvent.create({ data: { tenantId: A.tenantId, jobId: A.jobId, type: "job.note", clientEventId: "c-1" } }));
    await rejects(A, /unique/i, (tx) => tx.numberSequence.create({ data: { tenantId: A.tenantId, name: "job" } }));
    await rejects(A, /unique/i, (tx) => tx.employeeQualification.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "SKILL", skillId: A.skillId, level: 2 } }));
    await rejects(A, /unique/i, (tx) =>
      tx.job.create({ data: { tenantId: A.tenantId, number: 79, title: "dup", estimatedDurationMinutes: 30, customerId: A.customerId, serviceAddressId: A.addressId, jobTypeId: A.jobTypeId, orgUnitId: A.orgUnitId, leadId: A.leadId } }),
    );
    // The same codes/numbers in ANOTHER tenant are fine (uniqueness is per tenant): graph B reused them.
    expect(await withTenant(B.tenantId, (tx) => tx.skill.count({ where: { code: "hvac-install" } }))).toBe(1);
  });
});

describe("append-only history", () => {
  it("LeadStatusHistory, JobStatusHistory and JobEvent reject UPDATE, DELETE and TRUNCATE", async () => {
    await rejects(A, /append-only/, (tx) => tx.leadStatusHistory.updateMany({ data: { reason: "tampered" } }));
    await rejects(A, /append-only/, (tx) => tx.leadStatusHistory.deleteMany({}));
    await rejects(A, /append-only/, (tx) => tx.jobStatusHistory.updateMany({ data: { reason: "tampered" } }));
    await rejects(A, /append-only/, (tx) => tx.jobStatusHistory.deleteMany({}));
    await rejects(A, /append-only/, (tx) => tx.jobEvent.updateMany({ data: { type: "job.tampered" } }));
    await rejects(A, /append-only/, (tx) => tx.jobEvent.deleteMany({}));
    for (const table of ["LeadStatusHistory", "JobStatusHistory", "JobEvent"]) {
      await expect(prisma.$executeRawUnsafe(`TRUNCATE "${table}"`)).rejects.toThrow(/append-only/);
    }
    expect(await withTenant(A.tenantId, (tx) => tx.jobEvent.count({ where: { jobId: A.jobId } }))).toBeGreaterThan(0);
  });
});

describe("indexes the list and search queries rely on", () => {
  it("exist in the database", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(rows.map((r) => r.indexname));
    const expected = [
      "Customer_tenantId_phoneE164_idx", "Customer_tenantId_email_idx", "Customer_name_trgm_idx", "Customer_tenantId_number_key",
      "CustomerAddress_tenantId_normalizedKey_idx",
      "Lead_tenantId_status_createdAt_idx", "Lead_tenantId_status_nextFollowUpAt_idx", "Lead_tenantId_orgUnitId_status_idx",
      "Lead_tenantId_contactPhoneE164_idx", "Lead_tenantId_contactEmail_idx", "Lead_contactName_trgm_idx",
      "LeadAssignment_tenantId_employeeId_state_idx", "LeadAssignment_one_active_per_lead",
      "Job_tenantId_status_scheduledStartAt_idx", "Job_tenantId_orgUnitId_status_scheduledStartAt_idx", "Job_tenantId_customerId_createdAt_idx",
      "JobAssignment_tenantId_employeeId_state_idx", "JobAssignment_one_active_lead_per_job",
      "EmployeeQualification_tenantId_expiresAt_idx", "Availability_tenantId_employeeId_kind_isoDayOfWeek_idx",
      "Notification_tenantId_recipientId_readAt_createdAt_idx", "NotificationDelivery_due_retry_idx",
    ];
    for (const name of expected) expect(names.has(name), name).toBe(true);
  });
});

describe("field maps classify every stored column", () => {
  const columns = (model: string) =>
    Prisma.dmmf.datamodel.models.find((m) => m.name === model)!.fields.filter((f) => f.kind !== "object" && f.name !== "tenantId").map((f) => f.name);

  it.each([
    ["Customer", CUSTOMER_FIELD_MAP],
    ["Lead", LEAD_FIELD_MAP],
    ["Job", JOB_FIELD_MAP],
  ])("%s: a column added without a field-set tag fails here (it would stay hidden)", (model, map) => {
    // Relation scalars (FK columns) are columns too; only `tenantId` is deliberately unmapped.
    for (const column of columns(model)) expect(Object.hasOwn(map, column), `${model}.${column}`).toBe(true);
  });

  it("money fields are the opt-in financial set on jobs and the billing set on customers", () => {
    expect(JOB_FIELD_MAP.quotedAmountMinor).toBe("financial");
    expect(JOB_FIELD_MAP.currency).toBe("financial");
    expect(CUSTOMER_FIELD_MAP.taxId).toBe("billing");
    expect(CUSTOMER_FIELD_MAP.billingAddress).toBe("billing");
    expect(CUSTOMER_FIELD_MAP.name).toBe("base");
  });
});

describe("fix round 1: job permissions, coordinates, preferences, stricter foreign keys", () => {
  it("job-category permissions name exactly one job type or category, inside one tenant", async () => {
    const perm = (data: Partial<Prisma.EmployeeJobPermissionUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.employeeJobPermission.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, ...data } });
    await rejects(A, /employee_job_permission_target/, perm({}));
    await rejects(A, /employee_job_permission_target/, perm({ jobTypeId: A.jobTypeId, category: "repair" }));
    await rejects(A, /employee_job_permission_target/, perm({ category: "  " }));
    await rejects(A, /employee_job_permission_dates/, perm({ jobTypeId: A.jobTypeId, effectiveFrom: new Date("2026-02-01"), effectiveTo: new Date("2026-01-01") }));
    await rejects(A, /foreign key/i, perm({ jobTypeId: B.jobTypeId }));
    await expect(withTenant(A.tenantId, perm({ jobTypeId: A.jobTypeId, grantedById: A.userId }))).resolves.toBeDefined();
  });

  it("TRAINING is a qualification kind backed by a TRAINING certification", async () => {
    await withTenant(A.tenantId, async (tx) => {
      const course = await tx.certification.create({ data: { tenantId: A.tenantId, code: "safety-course", name: "Safety course", type: "TRAINING" } });
      await tx.employeeQualification.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "TRAINING", certificationId: course.id } });
    });
  });

  it("a qualification's kind must equal its certification's type (composite FK)", async () => {
    // A.certificationId is a LICENSE.
    await rejects(A, /foreign key/i, (tx) => tx.employeeQualification.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "EQUIPMENT", certificationId: A.certificationId } }));
    await rejects(A, /foreign key/i, (tx) => tx.employeeQualification.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "CERTIFICATION", certificationId: A.certificationId } }));
  });

  it("origin coordinates on org units and employees are ranged pairs", async () => {
    await rejects(A, /org_unit_latitude_range/, (tx) => tx.orgUnit.update({ where: { id: A.orgUnitId }, data: { latitude: "91", longitude: "10" } }));
    await rejects(A, /org_unit_longitude_range/, (tx) => tx.orgUnit.update({ where: { id: A.orgUnitId }, data: { latitude: "10", longitude: "181" } }));
    await rejects(A, /org_unit_coordinates_pair/, (tx) => tx.orgUnit.update({ where: { id: A.orgUnitId }, data: { latitude: "10" } }));
    await rejects(A, /employee_start_latitude_range/, (tx) => tx.employee.update({ where: { id: A.employeeId }, data: { startLatitude: "-91", startLongitude: "0" } }));
    await rejects(A, /employee_start_coordinates_pair/, (tx) => tx.employee.update({ where: { id: A.employeeId }, data: { startLongitude: "0" } }));
    await expect(withTenant(A.tenantId, (tx) => tx.orgUnit.update({ where: { id: A.orgUnitId }, data: { latitude: "32.7767", longitude: "-96.797" } }))).resolves.toBeDefined();
  });

  it("customer employee preferences are real tenant-safe rows, one per customer and employee", async () => {
    await rejects(A, /unique/i, (tx) => tx.customerPreferredEmployee.create({ data: { tenantId: A.tenantId, customerId: A.customerId, employeeId: A.employeeId, kind: "AVOID" } }));
    await rejects(A, /foreign key/i, (tx) => tx.customerPreferredEmployee.create({ data: { tenantId: A.tenantId, customerId: A.otherCustomerId, employeeId: B.employeeId } }));
    await rejects(A, /foreign key/i, (tx) => tx.customerPreferredEmployee.create({ data: { tenantId: A.tenantId, customerId: B.customerId, employeeId: A.employeeId } }));
  });

  it("an assignment's recommendation must be for the same job", async () => {
    const otherJob = await withTenant(A.tenantId, (tx) =>
      tx.job.create({ data: { tenantId: A.tenantId, number: 60, title: "other", estimatedDurationMinutes: 30, customerId: A.customerId, serviceAddressId: A.addressId, jobTypeId: A.jobTypeId, orgUnitId: A.orgUnitId } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobAssignment.create({ data: { tenantId: A.tenantId, jobId: otherJob.id, teamOrgUnitId: A.orgUnitId, role: "LEAD", method: "RECOMMENDATION_APPROVED", recommendationId: A.recommendationId } }),
    );
  });

  it("a job's lead must belong to the job's customer", async () => {
    const lead = await withTenant(A.tenantId, (tx) => tx.lead.create({ data: { tenantId: A.tenantId, number: 61, customerId: A.otherCustomerId } }));
    const job = (leadId: string) => (tx: TenantTx) =>
      tx.job.create({ data: { tenantId: A.tenantId, number: 62 + Math.floor(Math.random() * 1e6), title: "x", estimatedDurationMinutes: 30, customerId: A.customerId, serviceAddressId: A.addressId, jobTypeId: A.jobTypeId, orgUnitId: A.orgUnitId, leadId } });
    await rejects(A, /foreign key/i, job(lead.id)); // lead of another customer
    await rejects(A, /foreign key/i, job(A.otherLeadId)); // lead not linked to any customer yet
  });

  it("operations settings can only be updated-by a user of the same tenant", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.operationsSettings.update({ where: { tenantId: A.tenantId }, data: { updatedById: B.userId } }));
  });
});
