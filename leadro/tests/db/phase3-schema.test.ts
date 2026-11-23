import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_FIELD_MAP, LOCATION_EVENT_FIELD_MAP } from "@/server/authz";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { createTenant } from "../helpers";

/**
 * Phase 3 schema: tenant isolation of every new table, composite tenant-safe foreign keys, CHECK
 * constraints, partial unique indexes, triggers and the offline idempotency key. Constraint and
 * index names asserted here are part of the migration contract (20261123100000_phase3_field_operations).
 */

interface Graph {
  tenantId: string;
  userId: string;
  otherUserId: string;
  employeeId: string;
  otherEmployeeId: string;
  orgUnitId: string;
  customerId: string;
  otherCustomerId: string;
  leadId: string;
  jobTypeId: string;
  jobId: string;
  otherJobId: string;
  shiftId: string;
  locationEventId: string;
  fieldEventId: string;
  formId: string;
  lostReasonId: string;
  outcomeId: string;
  recoveryCaseId: string;
  ruleId: string;
  attachmentId: string;
  completionId: string;
  arrivalId: string;
}

const suffix = Math.random().toString(36).slice(2, 7);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let A: Graph;
let B: Graph;

/** One row in every Phase 3 table, so isolation can be asserted table by table. */
async function buildGraph(label: string): Promise<Graph> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;
  return withTenant(tenantId, async (tx) => {
    const orgUnit = await tx.orgUnit.create({ data: { tenantId, type: "BRANCH", name: `Branch ${label}` } });
    const user = await tx.user.create({ data: { tenantId, email: `u-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const otherUser = await tx.user.create({ data: { tenantId, email: `v-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const employee = await tx.employee.create({ data: { tenantId, userId: user.id, firstName: "Tech", lastName: label } });
    const otherEmployee = await tx.employee.create({ data: { tenantId, firstName: "Other", lastName: label } });
    const customer = await tx.customer.create({ data: { tenantId, number: 1, name: "Ann Customer", orgUnitId: orgUnit.id } });
    const otherCustomer = await tx.customer.create({ data: { tenantId, number: 2, name: "Bob Customer" } });
    const address = await tx.customerAddress.create({
      data: { tenantId, customerId: customer.id, line1: "1 Main St", city: "Dallas", region: "TX", postalCode: "75201", normalizedKey: `k-${label}`, latitude: "32.776700", longitude: "-96.797000", geofenceRadiusM: 200 },
    });
    const jobType = await tx.jobType.create({ data: { tenantId, code: "ac-install", name: "AC installation", category: "installation", defaultDurationMinutes: 180 } });
    const lead = await tx.lead.create({ data: { tenantId, number: 1, customerId: customer.id, contactName: "Ann" } });
    const job = await tx.job.create({
      data: { tenantId, number: 1, customerId: customer.id, serviceAddressId: address.id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, leadId: lead.id, title: "Install AC", estimatedDurationMinutes: 180, enRouteAt: new Date(), arrivedAt: new Date() },
    });
    const otherJob = await tx.job.create({
      data: { tenantId, number: 2, customerId: otherCustomer.id, serviceAddressId: (await tx.customerAddress.create({ data: { tenantId, customerId: otherCustomer.id, line1: "2 Main St", city: "Dallas", region: "TX", postalCode: "75201", normalizedKey: `k2-${label}` } })).id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, title: "Other", estimatedDurationMinutes: 60 },
    });
    await tx.operationsSettings.create({ data: { tenantId } });

    const shift = await tx.shift.create({ data: { tenantId, employeeId: employee.id, orgUnitId: orgUnit.id, startedAt: new Date(), deviceId: "dev-1" } });
    const fieldEvent = await tx.fieldEvent.create({
      data: { tenantId, employeeId: employee.id, actorUserId: user.id, clientEventId: uuid(1), type: "job.arrival", jobId: job.id, shiftId: shift.id, occurredAt: new Date(), result: "ACCEPTED", entityType: "ArrivalVerification", entityId: "x" },
    });
    const locationEvent = await tx.locationEvent.create({
      data: {
        tenantId, employeeId: employee.id, shiftId: shift.id, jobId: job.id, orgUnitId: orgUnit.id, kind: "ARRIVAL", source: "DEVICE_GPS", verification: "WITHIN_RADIUS",
        latitude: "32.776800", longitude: "-96.797100", accuracyM: 12, distanceToJobM: 15, geofenceRadiusM: 200, deviceTime: new Date(), fieldEventId: fieldEvent.id,
      },
    });
    await tx.shift.update({ where: { id: shift.id }, data: { startLocationEventId: locationEvent.id } });
    const arrival = await tx.arrivalVerification.create({
      data: { tenantId, jobId: job.id, employeeId: employee.id, shiftId: shift.id, method: "GEOFENCE", arrivedAt: new Date(), locationEventId: locationEvent.id, accuracyM: 12, distanceToJobM: 15, geofenceRadiusM: 200, fieldEventId: fieldEvent.id },
    });
    const form = await tx.jobCompletionFormDefinition.create({
      data: { tenantId, jobTypeId: jobType.id, version: 1, status: "ACTIVE", name: "Install form", schema: { fields: [] }, publishedAt: new Date() },
    });
    const attachment = await tx.jobAttachment.create({ data: { tenantId, jobId: job.id, kind: "SIGNATURE", fileName: "sig.png", contentType: "image/png", sizeBytes: 1000, uploadedById: user.id } });
    const completion = await tx.jobCompletion.create({
      data: { tenantId, jobId: job.id, employeeId: employee.id, formDefinitionId: form.id, formVersion: 1, values: { notes: "done" }, signatureAttachmentId: attachment.id, submittedById: user.id },
    });
    await tx.jobMaterialUsage.create({ data: { tenantId, jobId: job.id, completionId: completion.id, employeeId: employee.id, name: "Copper pipe", quantity: "2.5", unit: "m" } });
    await tx.jobFieldNote.create({ data: { tenantId, jobId: job.id, employeeId: employee.id, kind: "NOTE", body: "Customer asked about warranty" } });
    const lostReason = await tx.lostReason.create({ data: { tenantId, code: "price-too-high", name: "Price too high" } });
    const outcome = await tx.jobOutcome.create({
      data: { tenantId, jobId: job.id, employeeId: employee.id, outcome: "NOT_SOLD", lostReasonId: lostReason.id, quotedAmountMinor: 450000, recordedById: user.id },
    });
    const rule = await tx.recoveryRule.create({
      data: { tenantId, ruleKey: "price-objection", name: "Price objection", trigger: "job.not_converted", conditions: { outcomes: ["NOT_SOLD"] }, actions: [{ type: "create_case" }], createdById: user.id },
    });
    const recoveryCase = await tx.leadRecoveryCase.create({
      data: {
        tenantId, number: 1, jobOutcomeId: outcome.id, jobId: job.id, customerId: customer.id, leadId: lead.id, technicianId: employee.id, orgUnitId: orgUnit.id,
        lostReasonId: lostReason.id, outcomeAt: new Date(), ruleId: rule.id, ruleVersion: 1, initialValueMinor: 450000, presenceReason: "not_evaluated",
      },
    });
    await tx.recoveryRuleRun.create({
      data: { tenantId, ruleId: rule.id, ruleVersion: 1, jobOutcomeId: outcome.id, customerId: customer.id, matched: true, actionsTaken: ["create_case"], recoveryCaseId: recoveryCase.id },
    });
    await tx.recoveryCaseStatusHistory.create({ data: { tenantId, caseId: recoveryCase.id, toStatus: "NEW", actorUserId: user.id } });
    await tx.recoveryAttempt.create({ data: { tenantId, caseId: recoveryCase.id, employeeId: employee.id, channel: "PHONE", outcome: "NO_ANSWER", recordedById: user.id } });
    await tx.followUpTask.create({
      data: { tenantId, targetType: "RECOVERY_CASE", recoveryCaseId: recoveryCase.id, title: "Call customer", dueAt: new Date(Date.now() + 3_600_000), assigneeId: employee.id, createdById: user.id },
    });
    return {
      tenantId, userId: user.id, otherUserId: otherUser.id, employeeId: employee.id, otherEmployeeId: otherEmployee.id, orgUnitId: orgUnit.id,
      customerId: customer.id, otherCustomerId: otherCustomer.id, leadId: lead.id, jobTypeId: jobType.id, jobId: job.id, otherJobId: otherJob.id,
      shiftId: shift.id, locationEventId: locationEvent.id, fieldEventId: fieldEvent.id, formId: form.id, lostReasonId: lostReason.id,
      outcomeId: outcome.id, recoveryCaseId: recoveryCase.id, ruleId: rule.id, attachmentId: attachment.id, completionId: completion.id, arrivalId: arrival.id,
    };
  });
}

beforeAll(async () => {
  A = await buildGraph("p3a");
  B = await buildGraph("p3b");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** Runs `fn` in its own transaction for tenant `g` and expects the database to reject it, naming `rule`. */
const rejects = (g: Graph, rule: RegExp | string, fn: (tx: TenantTx) => Promise<unknown>) =>
  expect(withTenant(g.tenantId, fn)).rejects.toThrow(rule);

describe("tenant isolation of every Phase 3 table", () => {
  const TABLES = [
    "Shift", "LocationEvent", "ArrivalVerification", "FieldEvent", "JobCompletionFormDefinition", "JobCompletion",
    "JobMaterialUsage", "JobFieldNote", "JobAttachment", "LostReason", "JobOutcome", "RecoveryRule", "LeadRecoveryCase",
    "RecoveryCaseStatusHistory", "RecoveryAttempt", "FollowUpTask", "RecoveryRuleRun",
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
    expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
  });

  it("a tenant cannot insert a Phase 3 row under another tenant's id", async () => {
    await rejects(A, /row-level security/, (tx) =>
      tx.lostReason.create({ data: { tenantId: B.tenantId, code: "smuggled", name: "Smuggled" } }),
    );
    await rejects(A, /row-level security/, (tx) =>
      tx.shift.create({ data: { tenantId: B.tenantId, employeeId: B.employeeId, startedAt: new Date() } }),
    );
  });
});

describe("composite foreign keys keep every reference inside one tenant", () => {
  it("shifts, location events, arrivals and field events cannot point at another tenant's rows", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.shift.create({ data: { tenantId: A.tenantId, employeeId: B.employeeId, startedAt: new Date() } }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.locationEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, jobId: B.jobId, kind: "NAVIGATION_OPENED", source: "DEVICE_GPS", exception: "GPS_DISABLED", deviceTime: new Date() } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.arrivalVerification.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: B.employeeId, method: "TECHNICIAN", arrivedAt: new Date() } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.fieldEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, clientEventId: uuid(2), type: "job.note", jobId: B.jobId, occurredAt: new Date(), result: "ACCEPTED" } }),
    );
  });

  it("a location event's shift must belong to the same employee", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.locationEvent.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, shiftId: A.shiftId, kind: "SHIFT_START", source: "MANUAL" } }),
    );
  });

  it("an arrival's location event must belong to the arrival's own job", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.arrivalVerification.create({
        data: { tenantId: A.tenantId, jobId: A.otherJobId, employeeId: A.employeeId, method: "GEOFENCE", arrivedAt: new Date(), locationEventId: A.locationEventId, accuracyM: 10 },
      }),
    );
  });

  it("a completion points at a real (definition, version) pair of its own tenant", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobCompletion.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, employeeId: A.employeeId, formDefinitionId: A.formId, formVersion: 2, values: {} } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobCompletion.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, employeeId: A.employeeId, formDefinitionId: B.formId, formVersion: 1, values: {} } }),
    );
  });

  it("outcomes, recovery cases and follow-ups cannot cross tenants", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, outcome: "NOT_SOLD", lostReasonId: B.lostReasonId } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.followUpTask.create({ data: { tenantId: A.tenantId, targetType: "JOB", jobId: B.jobId, title: "x", dueAt: new Date() } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.followUpTask.create({ data: { tenantId: A.tenantId, targetType: "RECOVERY_CASE", recoveryCaseId: B.recoveryCaseId, title: "x", dueAt: new Date() } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.recoveryAttempt.create({ data: { tenantId: A.tenantId, caseId: B.recoveryCaseId, channel: "PHONE" } }),
    );
  });

  it("a recovery case and its job must agree on the customer, and the case must belong to the outcome's job", async () => {
    await rejects(A, /foreign key/i, (tx) =>
      tx.leadRecoveryCase.create({
        data: { tenantId: A.tenantId, number: 90, jobOutcomeId: A.outcomeId, jobId: A.jobId, customerId: A.otherCustomerId, outcomeAt: new Date() },
      }),
    );
    // An outcome of job 1 cannot back a case for job 2 (same customer or not).
    await withTenant(A.tenantId, (tx) =>
      tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, outcome: "CUSTOMER_UNAVAILABLE" } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.leadRecoveryCase.create({
        data: { tenantId: A.tenantId, number: 91, jobOutcomeId: A.outcomeId, jobId: A.otherJobId, customerId: A.otherCustomerId, outcomeAt: new Date() },
      }),
    );
  });
});

describe("offline idempotency and natural keys", () => {
  it("a field event is unique per (tenant, employee, clientEventId); the same id is fine for another employee or tenant", async () => {
    await rejects(A, /unique/i, (tx) =>
      tx.fieldEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, clientEventId: uuid(1), type: "job.note", occurredAt: new Date(), result: "ACCEPTED" } }),
    );
    await expect(
      withTenant(A.tenantId, (tx) =>
        tx.fieldEvent.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, clientEventId: uuid(1), type: "job.note", occurredAt: new Date(), result: "ACCEPTED" } }),
      ),
    ).resolves.toBeDefined();
    expect(await withTenant(B.tenantId, (tx) => tx.fieldEvent.count({ where: { clientEventId: uuid(1) } }))).toBe(1);
  });

  it("one location event per field event; one outcome and one completion per (job, visit); one case per outcome", async () => {
    await rejects(A, /unique/i, (tx) =>
      tx.locationEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "VERIFICATION", source: "MANUAL", fieldEventId: A.fieldEventId } }),
    );
    await rejects(A, /unique/i, (tx) =>
      tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.jobId, outcome: "SOLD" } }),
    );
    await rejects(A, /unique/i, (tx) =>
      tx.jobCompletion.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: A.employeeId, formDefinitionId: A.formId, formVersion: 1, values: {} } }),
    );
    await rejects(A, /unique/i, (tx) =>
      tx.leadRecoveryCase.create({ data: { tenantId: A.tenantId, number: 92, jobOutcomeId: A.outcomeId, jobId: A.jobId, customerId: A.customerId, outcomeAt: new Date() } }),
    );
  });

  it("client event ids on field-captured rows are unique per job", async () => {
    await withTenant(A.tenantId, (tx) => tx.jobFieldNote.create({ data: { tenantId: A.tenantId, jobId: A.jobId, body: "n", clientEventId: "note-1" } }));
    await rejects(A, /unique/i, (tx) => tx.jobFieldNote.create({ data: { tenantId: A.tenantId, jobId: A.jobId, body: "again", clientEventId: "note-1" } }));
  });

  it("an employee has one ACTIVE shift at a time; ended shifts are history", async () => {
    await rejects(A, /Shift_one_active_per_employee|unique/i, (tx) => tx.shift.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, startedAt: new Date() } }));
    await withTenant(A.tenantId, async (tx) => {
      await tx.shift.update({ where: { id: A.shiftId }, data: { status: "ENDED", endedAt: new Date(), endRecordedAt: new Date() } });
      await tx.shift.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, startedAt: new Date() } });
    });
    expect(await withTenant(A.tenantId, (tx) => tx.shift.count({ where: { employeeId: A.employeeId } }))).toBe(2);
  });

  it("lost reason codes are unique per tenant; a rule key has one ACTIVE version and versions are unique", async () => {
    await rejects(A, /unique/i, (tx) => tx.lostReason.create({ data: { tenantId: A.tenantId, code: "price-too-high", name: "Dup" } }));
    expect(await withTenant(B.tenantId, (tx) => tx.lostReason.count({ where: { code: "price-too-high" } }))).toBe(1);
    const rule = (version: number, status: "ACTIVE" | "SUPERSEDED") => (tx: TenantTx) =>
      tx.recoveryRule.create({
        data: { tenantId: A.tenantId, ruleKey: "two-versions", version, name: "Two versions", status, activatedAt: status === "ACTIVE" ? new Date() : null, trigger: "job.not_converted", conditions: {}, actions: [] },
      });
    await withTenant(A.tenantId, rule(1, "ACTIVE"));
    await rejects(A, /RecoveryRule_one_active_per_key|unique/i, rule(2, "ACTIVE"));
    await rejects(A, /unique/i, rule(1, "SUPERSEDED"));
    await expect(withTenant(A.tenantId, rule(2, "SUPERSEDED"))).resolves.toBeDefined();
  });

  it("a job type has one ACTIVE completion form; a draft can coexist and versions are unique", async () => {
    const form = (version: number, status: "ACTIVE" | "DRAFT") => (tx: TenantTx) =>
      tx.jobCompletionFormDefinition.create({
        data: { tenantId: A.tenantId, jobTypeId: A.jobTypeId, version, status, name: "v", schema: { fields: [] }, publishedAt: status === "ACTIVE" ? new Date() : null },
      });
    await rejects(A, /one_active_per_job_type|unique/i, form(2, "ACTIVE"));
    await expect(withTenant(A.tenantId, form(2, "DRAFT"))).resolves.toBeDefined();
    await rejects(A, /unique/i, form(2, "DRAFT"));
  });

  it("follow-up dedupe keys make a task idempotent per tenant", async () => {
    const task = (g: Graph) => (tx: TenantTx) =>
      tx.followUpTask.create({ data: { tenantId: g.tenantId, targetType: "JOB", jobId: g.jobId, title: "t", dueAt: new Date(), dedupeKey: "rule:price:job-1" } });
    await withTenant(A.tenantId, task(A));
    await rejects(A, /unique/i, task(A));
    await expect(withTenant(B.tenantId, task(B))).resolves.toBeDefined();
  });
});

describe("CHECK constraints", () => {
  const event = (data: Partial<Prisma.LocationEventUncheckedCreateInput>) => (tx: TenantTx) =>
    tx.locationEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, kind: "VERIFICATION", source: "DEVICE_GPS", deviceTime: new Date(), latitude: "32.7", longitude: "-96.8", accuracyM: 20, ...data } });

  it("location events: ranged coordinates as a pair, accuracy with every position, device time for device sources", async () => {
    await rejects(A, /location_event_latitude_range/, event({ latitude: "91" }));
    await rejects(A, /location_event_longitude_range/, event({ longitude: "-181" }));
    await rejects(A, /location_event_coordinates_pair/, event({ longitude: null }));
    await rejects(A, /location_event_accuracy_with_coordinates/, event({ accuracyM: null }));
    await rejects(A, /location_event_accuracy_range/, event({ accuracyM: -1 }));
    await rejects(A, /location_event_device_time_required/, event({ deviceTime: null }));
    await expect(withTenant(A.tenantId, event({}))).resolves.toBeDefined();
  });

  it("location events: no position needs a reason; arrival-kind events need a job; shift events a shift; manager entries a recorder", async () => {
    await rejects(A, /location_event_position_or_reason/, event({ latitude: null, longitude: null, accuracyM: null }));
    await expect(withTenant(A.tenantId, event({ latitude: null, longitude: null, accuracyM: null, exception: "GPS_DISABLED" }))).resolves.toBeDefined();
    await expect(withTenant(A.tenantId, event({ latitude: null, longitude: null, accuracyM: null, source: "MANUAL", deviceTime: null }))).resolves.toBeDefined();
    await rejects(A, /location_event_job_kinds_need_job/, event({ kind: "ARRIVAL" }));
    await rejects(A, /location_event_shift_kinds_need_shift/, event({ kind: "SHIFT_END" }));
    await rejects(A, /location_event_manager_recorder/, event({ source: "MANAGER", deviceTime: null }));
    await rejects(A, /location_event_other_exception_needs_note/, event({ exception: "OTHER" }));
  });

  it("location events: a radius verdict needs a position, a distance and a job; distance and radius come together", async () => {
    await rejects(A, /location_event_radius_verdict_needs_data/, event({ verification: "WITHIN_RADIUS" }));
    await rejects(A, /location_event_distance_pair/, event({ distanceToJobM: 10, jobId: A.jobId }));
    await rejects(A, /location_event_distance_range/, event({ distanceToJobM: -5, geofenceRadiusM: 100, jobId: A.jobId }));
    await expect(withTenant(A.tenantId, event({ verification: "OUTSIDE_RADIUS", distanceToJobM: 900, geofenceRadiusM: 150, jobId: A.jobId }))).resolves.toBeDefined();
  });

  it("shifts: ACTIVE has no end, ENDED has one, dates ordered, an override by someone else needs a reason", async () => {
    const shift = (data: Partial<Prisma.ShiftUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.shift.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, startedAt: new Date("2026-12-01T12:00:00Z"), ...data } });
    await rejects(A, /shift_state_ended/, shift({ status: "ENDED" }));
    await rejects(A, /shift_state_ended/, shift({ endedAt: new Date("2026-12-01T20:00:00Z") }));
    await rejects(A, /shift_dates/, shift({ status: "ENDED", endedAt: new Date("2026-12-01T11:00:00Z"), endRecordedAt: new Date() }));
    await rejects(A, /shift_end_by_other_needs_reason/, shift({ endedByUserId: A.userId, status: "ENDED", endedAt: new Date("2026-12-01T20:00:00Z"), endRecordedAt: new Date() }));
    await rejects(A, /shift_other_exception_needs_note/, shift({ startException: "OTHER", exceptionReviewStatus: "PENDING" }));
    await expect(withTenant(A.tenantId, shift({ startException: "GPS_DISABLED", startExceptionNote: "phone GPS off", exceptionReviewStatus: "PENDING" }))).resolves.toBeDefined();
  });

  it("arrival verification: geofence needs its event, manager methods and decisions record who and why, exceptions are explained", async () => {
    const arrival = (data: Partial<Prisma.ArrivalVerificationUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.arrivalVerification.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: A.employeeId, method: "TECHNICIAN", arrivedAt: new Date(), ...data } });
    await rejects(A, /arrival_verification_geofence_needs_event/, arrival({ method: "GEOFENCE" }));
    await rejects(A, /arrival_verification_manager_method/, arrival({ method: "MANAGER" }));
    await rejects(A, /arrival_verification_decision/, arrival({ status: "MANAGER_VERIFIED" }));
    await rejects(A, /arrival_verification_decision/, arrival({ status: "RECORDED", verifiedByUserId: A.userId, verifiedAt: new Date(), verificationNote: "x" }));
    await rejects(A, /arrival_verification_pending_needs_exception/, arrival({ status: "PENDING_MANAGER_REVIEW" }));
    await rejects(A, /arrival_verification_other_exception_needs_note/, arrival({ exceptionReason: "OTHER" }));
    await rejects(A, /arrival_verification_ranges/, arrival({ geofenceRadiusM: 0 }));
    await expect(
      withTenant(A.tenantId, arrival({ method: "MANAGER", status: "MANAGER_VERIFIED", verifiedByUserId: A.userId, verifiedAt: new Date(), verificationNote: "Customer confirmed by phone" })),
    ).resolves.toBeDefined();
    await expect(withTenant(A.tenantId, arrival({ status: "PENDING_MANAGER_REVIEW", exceptionReason: "OUTSIDE_GEOFENCE" }))).resolves.toBeDefined();
  });

  it("field events: UUID client ids, dotted types, a result code for anything but ACCEPTED, entity pair", async () => {
    const fe = (data: Partial<Prisma.FieldEventUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.fieldEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, clientEventId: uuid(Math.floor(Math.random() * 1e9)), type: "job.note", occurredAt: new Date(), result: "ACCEPTED", ...data } });
    await rejects(A, /field_event_client_event_id_uuid/, fe({ clientEventId: "not-a-uuid" }));
    await rejects(A, /field_event_type_format/, fe({ type: "Job Note" }));
    await rejects(A, /field_event_result_code/, fe({ result: "REJECTED" }));
    await rejects(A, /field_event_result_code/, fe({ result: "ACCEPTED", resultCode: "x" }));
    await rejects(A, /field_event_entity_pair/, fe({ entityType: "JobFieldNote" }));
    await expect(withTenant(A.tenantId, fe({ result: "CONFLICT", resultCode: "job.invalid_transition" }))).resolves.toBeDefined();
  });

  it("completion forms: one target, version, shape; completions and materials", async () => {
    const form = (data: Partial<Prisma.JobCompletionFormDefinitionUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.jobCompletionFormDefinition.create({ data: { tenantId: A.tenantId, version: 7, name: "f", schema: { fields: [] }, jobTypeId: A.jobTypeId, ...data } });
    await rejects(A, /job_completion_form_target/, form({ category: "repair" }));
    await rejects(A, /job_completion_form_target/, form({ jobTypeId: null }));
    await rejects(A, /job_completion_form_version_positive/, form({ version: 0 }));
    await rejects(A, /job_completion_form_published/, form({ status: "ACTIVE" }));
    await rejects(A, /job_completion_form_schema_shape/, form({ schema: { fields: "x" } }));
    await expect(withTenant(A.tenantId, form({ jobTypeId: null, category: "repair" }))).resolves.toBeDefined(); // category-level form
    await rejects(A, /job_completion_values_shape/, (tx) =>
      tx.jobCompletion.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, employeeId: A.employeeId, formDefinitionId: A.formId, formVersion: 1, values: [] } }),
    );
    await rejects(A, /job_material_usage_quantity_positive/, (tx) =>
      tx.jobMaterialUsage.create({ data: { tenantId: A.tenantId, jobId: A.jobId, name: "x", quantity: "0" } }),
    );
  });

  it("field notes and attachments: amounts only where they make sense, no STORED file without a key", async () => {
    const note = (data: Partial<Prisma.JobFieldNoteUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.jobFieldNote.create({ data: { tenantId: A.tenantId, jobId: A.jobId, body: "b", ...data } });
    await rejects(A, /job_field_note_amount/, note({ kind: "NOTE", amountMinor: 100 }));
    await rejects(A, /job_field_note_amount/, note({ kind: "ADDITIONAL_WORK_REQUESTED", amountMinor: -1 }));
    await rejects(A, /job_field_note_approval_flag/, note({ kind: "NOTE", customerApproved: true }));
    await rejects(A, /job_field_note_currency_format/, note({ currency: "usd" }));
    await expect(withTenant(A.tenantId, note({ kind: "CUSTOMER_APPROVAL", amountMinor: 25000, customerApproved: true }))).resolves.toBeDefined();

    const attachment = (data: Partial<Prisma.JobAttachmentUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.jobAttachment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, fileName: "a.jpg", contentType: "image/jpeg", sizeBytes: 5000, ...data } });
    await rejects(A, /job_attachment_stored_needs_key/, attachment({ status: "STORED" }));
    await rejects(A, /job_attachment_size_range/, attachment({ sizeBytes: 0 }));
    await rejects(A, /job_attachment_checksum_format/, attachment({ checksumSha256: "abc" }));
    await rejects(A, /job_attachment_content_type_format/, attachment({ contentType: "JPEG" }));
    await expect(withTenant(A.tenantId, attachment({ status: "STORED", storageKey: "k", storageProvider: "s3" }))).resolves.toBeDefined();
  });

  it("outcomes: unsuccessful outcomes need a reason, SOLD has none, money is non-negative, paid needs a method and amount", async () => {
    const outcome = (data: Partial<Prisma.JobOutcomeUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, visitNumber: Math.floor(Math.random() * 1e6) + 10, outcome: "SOLD", ...data } });
    await rejects(A, /job_outcome_reason_rules/, outcome({ outcome: "NOT_SOLD" }));
    await rejects(A, /job_outcome_reason_rules/, outcome({ outcome: "WORK_NOT_POSSIBLE" }));
    await rejects(A, /job_outcome_reason_rules/, outcome({ outcome: "SOLD", lostReasonId: A.lostReasonId }));
    await rejects(A, /job_outcome_amounts_non_negative/, outcome({ chargedAmountMinor: -1 }));
    await rejects(A, /job_outcome_currency_format/, outcome({ currency: "US" }));
    await rejects(A, /job_outcome_payment_collected/, outcome({ paymentStatus: "PAID" }));
    await rejects(A, /job_outcome_visit_positive/, (tx) => tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, visitNumber: 0, outcome: "SOLD" } }));
    await expect(withTenant(A.tenantId, outcome({ outcome: "CUSTOMER_UNAVAILABLE" }))).resolves.toBeDefined();
    await expect(
      withTenant(A.tenantId, outcome({ chargedAmountMinor: 450000, collectedAmountMinor: 450000, paymentMethod: "CARD", paymentStatus: "PAID" })),
    ).resolves.toBeDefined();
  });

  it("lost reasons and recovery rules: formats, shapes and separation of duties for high-impact activation", async () => {
    await rejects(A, /lost_reason_code_format/, (tx) => tx.lostReason.create({ data: { tenantId: A.tenantId, code: "Bad Code", name: "x" } }));
    await rejects(A, /lost_reason_applies_to_present/, (tx) => tx.lostReason.create({ data: { tenantId: A.tenantId, code: "empty", name: "x", appliesTo: [] } }));
    const rule = (data: Partial<Prisma.RecoveryRuleUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.recoveryRule.create({ data: { tenantId: A.tenantId, ruleKey: `r-${Math.random().toString(36).slice(2, 8)}`, name: "r", trigger: "job.not_converted", conditions: {}, actions: [], ...data } });
    await rejects(A, /recovery_rule_key_format/, rule({ ruleKey: "Bad Key" }));
    await rejects(A, /recovery_rule_trigger_format/, rule({ trigger: "Job Not Converted" }));
    await rejects(A, /recovery_rule_json_shape/, rule({ actions: {} }));
    await rejects(A, /recovery_rule_ranges/, rule({ cooldownMinutes: -1 }));
    await rejects(A, /recovery_rule_pending_submitted/, rule({ status: "PENDING_APPROVAL" }));
    await rejects(A, /recovery_rule_active_activated/, rule({ status: "ACTIVE" }));
    // High-impact + ACTIVE needs an approver who is not the author.
    await rejects(A, /recovery_rule_high_impact_needs_author/, rule({ highImpact: true }));
    await rejects(A, /recovery_rule_high_impact_approval/, rule({ status: "ACTIVE", activatedAt: new Date(), highImpact: true, createdById: A.userId }));
    await rejects(A, /recovery_rule_high_impact_approval/, rule({ status: "ACTIVE", activatedAt: new Date(), highImpact: true, createdById: A.userId, approvedById: A.userId, approvedAt: new Date() }));
    await expect(
      withTenant(A.tenantId, rule({ status: "ACTIVE", activatedAt: new Date(), highImpact: true, createdById: A.userId, approvedById: A.otherUserId, approvedAt: new Date() })),
    ).resolves.toBeDefined();
    await expect(withTenant(A.tenantId, rule({ status: "ACTIVE", activatedAt: new Date() }))).resolves.toBeDefined(); // low impact needs no approval
  });

  it("recovery cases: confirmed revenue needs a recovery time, presence needs evidence, closed state matches its time", async () => {
    const outcomeFor = async () =>
      withTenant(A.tenantId, (tx) =>
        tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, visitNumber: Math.floor(Math.random() * 1e6) + 100, outcome: "CUSTOMER_UNAVAILABLE" } }),
      );
    let number = 200;
    const makeCase = async (data: Partial<Prisma.LeadRecoveryCaseUncheckedCreateInput>) => {
      const o = await outcomeFor();
      return (tx: TenantTx) =>
        tx.leadRecoveryCase.create({ data: { tenantId: A.tenantId, number: number++, jobOutcomeId: o.id, jobId: A.otherJobId, customerId: A.otherCustomerId, outcomeAt: new Date(), presenceReason: "not_evaluated", ...data } });
    };
    await rejects(A, /lead_recovery_case_confirmed_needs_time/, await makeCase({ recoveredAmountMinor: 1000 }));
    await rejects(A, /lead_recovery_case_recovered_has_time/, await makeCase({ status: "RECOVERED" }));
    await rejects(A, /lead_recovery_case_closed_state/, await makeCase({ status: "CLOSED" }));
    await rejects(A, /lead_recovery_case_closed_state/, await makeCase({ closedAt: new Date() }));
    await rejects(A, /lead_recovery_case_assigned_has_owner/, await makeCase({ status: "ASSIGNED" }));
    await rejects(A, /lead_recovery_case_presence_evidence/, await makeCase({ presenceStatus: "AT_LOCATION" }));
    await rejects(A, /lead_recovery_case_amounts_non_negative/, await makeCase({ estimatedValueMinor: -5 }));
    await rejects(A, /lead_recovery_case_rule_version_pair/, await makeCase({ ruleId: A.ruleId }));
    await rejects(A, /lead_recovery_case_not_own_recovery/, await makeCase({ recoveredJobId: A.otherJobId, recoveredAt: new Date() }));
    await expect(
      withTenant(A.tenantId, await makeCase({ status: "RECOVERED", recoveredAt: new Date(), recoveredAmountMinor: 380000, collectedAmountMinor: 380000, estimatedValueMinor: 450000 })),
    ).resolves.toBeDefined();
    await expect(
      withTenant(A.tenantId, await makeCase({ presenceStatus: "AT_LOCATION", presenceReason: null, technicianId: A.employeeId, presenceLocationEventId: A.locationEventId, presenceAccuracyM: 12, presenceEvaluatedAt: new Date() })),
    ).resolves.toBeDefined();
  });

  it("follow-up tasks: exactly the matching target column, consistent state, a cancel reason", async () => {
    const task = (data: Partial<Prisma.FollowUpTaskUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.followUpTask.create({ data: { tenantId: A.tenantId, targetType: "JOB", jobId: A.jobId, title: "t", dueAt: new Date(), ...data } });
    await rejects(A, /follow_up_task_target_shape/, task({ targetType: "LEAD" }));
    await rejects(A, /follow_up_task_target_shape/, task({ leadId: A.leadId }));
    await rejects(A, /follow_up_task_target_shape/, task({ jobId: null }));
    await rejects(A, /follow_up_task_state/, task({ status: "DONE" }));
    await rejects(A, /follow_up_task_state/, task({ status: "OPEN", completedAt: new Date() }));
    await rejects(A, /follow_up_task_state/, task({ status: "CANCELLED", cancelledAt: new Date() }));
    await rejects(A, /follow_up_task_title_present/, task({ title: "  " }));
    await expect(withTenant(A.tenantId, task({ status: "DONE", completedAt: new Date(), completedById: A.userId }))).resolves.toBeDefined();
    await expect(withTenant(A.tenantId, task({ targetType: "LEAD", jobId: null, leadId: A.leadId }))).resolves.toBeDefined();
    await expect(withTenant(A.tenantId, task({ targetType: "CUSTOMER", jobId: null, customerId: A.customerId }))).resolves.toBeDefined();
  });

  it("operations settings and addresses: Phase 3 knobs stay in range", async () => {
    await rejects(A, /operations_settings_location_ranges/, (tx) => tx.operationsSettings.update({ where: { tenantId: A.tenantId }, data: { arrivalGeofenceRadiusM: 5 } }));
    await rejects(A, /operations_settings_location_ranges/, (tx) => tx.operationsSettings.update({ where: { tenantId: A.tenantId }, data: { locationRetentionDays: 0 } }));
    await rejects(A, /customer_address_geofence_radius/, (tx) => tx.customerAddress.updateMany({ data: { geofenceRadiusM: 6000 } }));
    const settings = await withTenant(B.tenantId, (tx) => tx.operationsSettings.findUniqueOrThrow({ where: { tenantId: B.tenantId } }));
    expect(settings).toMatchObject({ arrivalGeofenceRadiusM: 150, locationMaxAccuracyM: 100, presenceMaxAgeMinutes: 30, locationRetentionDays: 90, followUpDueSoonMinutes: 60 });
  });

  it("recovery attempts and status history", async () => {
    await rejects(A, /recovery_case_status_history_changed/, (tx) =>
      tx.recoveryCaseStatusHistory.create({ data: { tenantId: A.tenantId, caseId: A.recoveryCaseId, fromStatus: "NEW", toStatus: "NEW" } }),
    );
    await rejects(A, /recovery_attempt_ranges/, (tx) => tx.recoveryAttempt.create({ data: { tenantId: A.tenantId, caseId: A.recoveryCaseId, channel: "SMS", durationSeconds: -1 } }));
  });
});

describe("triggers", () => {
  it("RecoveryCaseStatusHistory is append-only (UPDATE, DELETE and TRUNCATE are rejected)", async () => {
    await rejects(A, /append-only/, (tx) => tx.recoveryCaseStatusHistory.updateMany({ data: { reason: "tampered" } }));
    await rejects(A, /append-only/, (tx) => tx.recoveryCaseStatusHistory.deleteMany({}));
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "RecoveryCaseStatusHistory"`)).rejects.toThrow(/append-only/);
    expect(await withTenant(A.tenantId, (tx) => tx.recoveryCaseStatusHistory.count({ where: { caseId: A.recoveryCaseId } }))).toBeGreaterThan(0);
  });

  it("a published completion form definition is immutable; only a draft may change its schema, and status never moves back", async () => {
    await rejects(A, /immutable/, (tx) => tx.jobCompletionFormDefinition.update({ where: { id: A.formId }, data: { schema: { fields: [{ key: "notes" }] } } }));
    await rejects(A, /immutable/, (tx) => tx.jobCompletionFormDefinition.update({ where: { id: A.formId }, data: { version: 9 } }));
    await rejects(A, /cannot move back/, (tx) => tx.jobCompletionFormDefinition.update({ where: { id: A.formId }, data: { status: "DRAFT" } }));
    // Renaming and retiring a published definition is allowed; un-retiring is not.
    await withTenant(A.tenantId, (tx) => tx.jobCompletionFormDefinition.update({ where: { id: A.formId }, data: { name: "Renamed", status: "RETIRED" } }));
    await rejects(A, /cannot move back/, (tx) => tx.jobCompletionFormDefinition.update({ where: { id: A.formId }, data: { status: "ACTIVE" } }));
    const draft = await withTenant(A.tenantId, (tx) =>
      tx.jobCompletionFormDefinition.create({ data: { tenantId: A.tenantId, category: "inspection", version: 1, name: "d", schema: { fields: [] } } }),
    );
    await expect(
      withTenant(A.tenantId, (tx) => tx.jobCompletionFormDefinition.update({ where: { id: draft.id }, data: { schema: { fields: [{ key: "notes" }] } } })),
    ).resolves.toBeDefined();
  });
});

describe("indexes the Phase 3 queries rely on", () => {
  it("exist in the database", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(rows.map((r) => r.indexname));
    const expected = [
      "Shift_one_active_per_employee", "Shift_tenantId_employeeId_startedAt_idx",
      "LocationEvent_tenantId_employeeId_serverTime_idx", "LocationEvent_tenantId_serverTime_idx", "LocationEvent_tenantId_fieldEventId_key",
      "ArrivalVerification_pending_review_idx", "FieldEvent_tenantId_employeeId_clientEventId_key",
      "JobCompletionFormDefinition_one_active_per_job_type", "JobCompletionFormDefinition_one_active_per_category",
      "JobOutcome_tenantId_jobId_visitNumber_key", "RecoveryRule_one_active_per_key",
      "LeadRecoveryCase_tenantId_jobOutcomeId_key", "LeadRecoveryCase_tenantId_status_priority_outcomeAt_idx",
      "FollowUpTask_open_due_idx", "FollowUpTask_tenantId_assigneeId_status_dueAt_idx", "FollowUpTask_tenantId_dedupeKey_key",
      "Job_id_customerId_tenantId_key", "LocationEvent_id_employeeId_tenantId_key", "RecoveryRuleRun_tenantId_ruleId_jobOutcomeId_key",
      "RecoveryRule_id_version_tenantId_key",
    ];
    for (const name of expected) expect(names.has(name), name).toBe(true);
  });
});

describe("field maps classify every stored column", () => {
  const columns = (model: string) =>
    Prisma.dmmf.datamodel.models.find((m) => m.name === model)!.fields.filter((f) => f.kind !== "object" && f.name !== "tenantId").map((f) => f.name);

  it("LocationEvent: every column is classified and raw coordinates are the opt-in coordinates set", () => {
    for (const column of columns("LocationEvent")) expect(Object.hasOwn(LOCATION_EVENT_FIELD_MAP, column), `LocationEvent.${column}`).toBe(true);
    expect(LOCATION_EVENT_FIELD_MAP.latitude).toBe("coordinates");
    expect(LOCATION_EVENT_FIELD_MAP.longitude).toBe("coordinates");
    expect(LOCATION_EVENT_FIELD_MAP.accuracyM).toBe("base");
    expect(LOCATION_EVENT_FIELD_MAP.serverTime).toBe("base");
  });

  it("the new Job milestone columns are classified (operational, not financial)", () => {
    expect(JOB_FIELD_MAP.enRouteAt).toBe("base");
    expect(JOB_FIELD_MAP.arrivedAt).toBe("base");
    expect(JOB_FIELD_MAP.currentVisitNumber).toBe("base");
  });
});

describe("fix round 1: retention purge, rule immutability, shift review, rule runs, tighter keys", () => {
  it("retention: coordinates can be purged (UPDATE) from events referenced by a shift, an arrival and a recovery case", async () => {
    // A.locationEventId is the shift's start event, the evidence of a GEOFENCE arrival and (below) a case's presence evidence.
    await withTenant(A.tenantId, async (tx) => {
      await tx.leadRecoveryCase.update({
        where: { id: A.recoveryCaseId },
        data: { presenceStatus: "AT_LOCATION", presenceReason: null, presenceLocationEventId: A.locationEventId, presenceAccuracyM: 12, presenceEvaluatedAt: new Date() },
      });
    });
    await rejects(A, /foreign key|violates/i, (tx) => tx.locationEvent.delete({ where: { id: A.locationEventId } })); // deleting is not the strategy
    const purged = await withTenant(A.tenantId, (tx) =>
      tx.locationEvent.update({ where: { id: A.locationEventId }, data: { latitude: null, longitude: null, coordinatesPurgedAt: new Date() } }),
    );
    expect(purged).toMatchObject({ latitude: null, longitude: null, verification: "WITHIN_RADIUS", accuracyM: 12, distanceToJobM: 15 });
    // The references and the derived verdict survive the purge.
    expect(await withTenant(A.tenantId, (tx) => tx.arrivalVerification.count({ where: { id: A.arrivalId, locationEventId: A.locationEventId } }))).toBe(1);
    expect(await withTenant(A.tenantId, (tx) => tx.shift.count({ where: { id: A.shiftId, startLocationEventId: A.locationEventId } }))).toBe(1);
    // A purged event cannot get coordinates back under the same stamp.
    await rejects(A, /location_event_purged_has_no_coordinates/, (tx) =>
      tx.locationEvent.update({ where: { id: A.locationEventId }, data: { latitude: "32.7", longitude: "-96.8" } }),
    );
    // Without the stamp the position-less radius verdict is still refused.
    await rejects(A, /location_event_radius_verdict_needs_data|location_event_position_or_reason/, (tx) =>
      tx.locationEvent.update({ where: { id: A.locationEventId }, data: { coordinatesPurgedAt: null } }),
    );
  });

  it("same-employee and same-job composite keys", async () => {
    // A shift's start/end event must be the shift's own employee's event.
    const foreignEvent = await withTenant(A.tenantId, (tx) =>
      tx.locationEvent.create({ data: { tenantId: A.tenantId, employeeId: A.otherEmployeeId, kind: "VERIFICATION", source: "MANUAL" } }),
    );
    await rejects(A, /foreign key/i, (tx) => tx.shift.update({ where: { id: A.shiftId }, data: { endLocationEventId: foreignEvent.id } }));
    // An arrival's evidence must be the arriving employee's event.
    await rejects(A, /foreign key/i, (tx) =>
      tx.arrivalVerification.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: A.otherEmployeeId, method: "TECHNICIAN", arrivedAt: new Date(), locationEventId: A.locationEventId } }),
    );
    // A completion's signature and a material's completion must belong to the same job.
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobCompletion.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, employeeId: A.employeeId, formDefinitionId: A.formId, formVersion: 1, values: {}, signatureAttachmentId: A.attachmentId } }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobMaterialUsage.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, completionId: A.completionId, name: "x", quantity: "1" } }),
    );
    // A case's presence evidence must be the case technician's event.
    await rejects(A, /foreign key/i, (tx) =>
      tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { technicianId: A.otherEmployeeId } }),
    );
    // An arrival's field event is a tenant-safe reference.
    await rejects(A, /foreign key/i, (tx) =>
      tx.arrivalVerification.create({ data: { tenantId: A.tenantId, jobId: A.jobId, employeeId: A.employeeId, method: "TECHNICIAN", arrivedAt: new Date(), fieldEventId: B.fieldEventId } }),
    );
  });

  it("recovery cases: rule version is a real (id, version) pair; recovered lead/job share the customer; UNKNOWN presence needs a reason and no event", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { ruleVersion: 9 } }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { recoveredLeadId: A.leadId, recoveredAt: new Date(), customerId: A.otherCustomerId } }),
    );
    await rejects(A, /lead_recovery_case_confirmed_needs_time/, (tx) =>
      tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { recoveredLeadId: A.leadId } }),
    );
    await withTenant(A.tenantId, (tx) =>
      tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { recoveredLeadId: A.leadId, recoveredAt: new Date(), status: "RECOVERED" } }),
    );
    await rejects(A, /lead_recovery_case_presence_evidence/, (tx) =>
      tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { presenceStatus: "UNKNOWN", presenceReason: null } }),
    );
    await rejects(A, /lead_recovery_case_presence_evidence/, (tx) =>
      tx.leadRecoveryCase.update({ where: { id: A.recoveryCaseId }, data: { presenceStatus: "UNKNOWN", presenceReason: "stale_location" } }),
    ); // still references the evidence event
  });

  it("recovery rules: once out of DRAFT the behavior is immutable and status moves forward only", async () => {
    const make = (data: Partial<Prisma.RecoveryRuleUncheckedCreateInput> = {}) =>
      withTenant(A.tenantId, (tx) =>
        tx.recoveryRule.create({
          data: { tenantId: A.tenantId, ruleKey: `imm-${Math.random().toString(36).slice(2, 8)}`, name: "n", trigger: "job.not_converted", conditions: { outcomes: ["NOT_SOLD"] }, actions: [{ type: "recommend", code: "call_customer" }], createdById: A.userId, ...data },
        }),
      );
    const draft = await make();
    await expect(withTenant(A.tenantId, (tx) => tx.recoveryRule.update({ where: { id: draft.id }, data: { actions: [{ type: "create_case" }], highImpact: true } }))).resolves.toBeDefined();
    const pending = await make({ status: "PENDING_APPROVAL", submittedAt: new Date(), highImpact: true });
    for (const data of [
      { conditions: { outcomes: ["SOLD"] } }, { actions: [] }, { trigger: "job.other" }, { priority: 1 }, { orgUnitId: A.orgUnitId }, { highImpact: false }, { version: 2 }, { createdById: A.otherUserId },
    ] as Prisma.RecoveryRuleUncheckedUpdateInput[]) {
      await rejects(A, /immutable/, (tx) => tx.recoveryRule.update({ where: { id: pending.id }, data }));
    }
    await rejects(A, /cannot move/, (tx) => tx.recoveryRule.update({ where: { id: pending.id }, data: { status: "DRAFT" } }));
    // The approval (a different person) and activation columns stay writable, and an approved rule activates.
    await withTenant(A.tenantId, (tx) => tx.recoveryRule.update({ where: { id: pending.id }, data: { status: "ACTIVE", approvedById: A.otherUserId, approvedAt: new Date(), activatedAt: new Date(), name: "Renamed" } }));
    await withTenant(A.tenantId, (tx) => tx.recoveryRule.update({ where: { id: pending.id }, data: { status: "INACTIVE" } }));
    await withTenant(A.tenantId, (tx) => tx.recoveryRule.update({ where: { id: pending.id }, data: { status: "SUPERSEDED" } }));
    await rejects(A, /cannot move/, (tx) => tx.recoveryRule.update({ where: { id: pending.id }, data: { status: "ACTIVE" } }));
  });

  it("shift exception review: no exception, no review; PENDING has no decision; a decision records who, when and why", async () => {
    const fresh = await withTenant(A.tenantId, (tx) => tx.employee.create({ data: { tenantId: A.tenantId, firstName: "Fresh", lastName: "Tech" } }));
    const shift = (data: Partial<Prisma.ShiftUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.shift.create({ data: { tenantId: A.tenantId, employeeId: fresh.id, startedAt: new Date(), ...data } });
    await rejects(A, /shift_exception_review/, shift({ exceptionReviewStatus: "PENDING" })); // review without an exception
    await rejects(A, /shift_exception_review/, shift({ startException: "POOR_SIGNAL" })); // exception without a review state
    await rejects(A, /shift_exception_review/, shift({ startException: "POOR_SIGNAL", exceptionReviewStatus: "APPROVED" }));
    await rejects(A, /shift_exception_review/, shift({ startException: "POOR_SIGNAL", exceptionReviewStatus: "PENDING", reviewedById: A.userId }));
    const created = await withTenant(A.tenantId, shift({ startException: "POOR_SIGNAL", exceptionReviewStatus: "PENDING" }));
    await withTenant(A.tenantId, (tx) =>
      tx.shift.update({ where: { id: created.id }, data: { exceptionReviewStatus: "APPROVED", reviewedById: A.userId, reviewedAt: new Date(), reviewNote: "Signal was poor at the depot" } }),
    );
  });

  it("rule runs: one per (rule, outcome), composite FKs, append-only, consistent shape", async () => {
    const run = (data: Partial<Prisma.RecoveryRuleRunUncheckedCreateInput>) => (tx: TenantTx) =>
      tx.recoveryRuleRun.create({ data: { tenantId: A.tenantId, ruleId: A.ruleId, ruleVersion: 1, jobOutcomeId: A.outcomeId, customerId: A.customerId, matched: false, ...data } });
    await rejects(A, /unique/i, run({}));
    await rejects(A, /foreign key/i, (tx) => tx.recoveryRuleRun.create({ data: { tenantId: A.tenantId, ruleId: A.ruleId, ruleVersion: 5, jobOutcomeId: A.outcomeId, customerId: A.customerId, matched: false } }));
    await rejects(A, /foreign key/i, (tx) => tx.recoveryRuleRun.create({ data: { tenantId: A.tenantId, ruleId: B.ruleId, ruleVersion: 1, jobOutcomeId: A.outcomeId, customerId: A.customerId, matched: false } }));
    const otherOutcome = await withTenant(A.tenantId, (tx) => tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, visitNumber: 777, outcome: "CUSTOMER_UNAVAILABLE" } }));
    await rejects(A, /recovery_rule_run_shape/, run({ jobOutcomeId: otherOutcome.id, matched: false, actionsTaken: ["create_case"] }));
    await rejects(A, /recovery_rule_run_shape/, run({ jobOutcomeId: otherOutcome.id, matched: true, skippedReason: "cooldown", actionsTaken: ["notify"] }));
    await expect(withTenant(A.tenantId, run({ jobOutcomeId: otherOutcome.id, matched: true, skippedReason: "cooldown", actionsTaken: [] }))).resolves.toBeDefined();
    await rejects(A, /append-only/, (tx) => tx.recoveryRuleRun.updateMany({ data: { skippedReason: "x" } }));
    await rejects(A, /append-only/, (tx) => tx.recoveryRuleRun.deleteMany({}));
  });

  it("field event payload hash is sha256 hex; job visit number and REFUSED payment status exist", async () => {
    await rejects(A, /field_event_payload_hash_format/, (tx) =>
      tx.fieldEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, clientEventId: uuid(31), type: "job.note", occurredAt: new Date(), result: "ACCEPTED", payloadHash: "abc" } }),
    );
    await expect(
      withTenant(A.tenantId, (tx) =>
        tx.fieldEvent.create({ data: { tenantId: A.tenantId, employeeId: A.employeeId, clientEventId: uuid(32), type: "job.note", occurredAt: new Date(), result: "ACCEPTED", payloadHash: "a".repeat(64) } }),
      ),
    ).resolves.toBeDefined();
    expect((await withTenant(A.tenantId, (tx) => tx.job.findUniqueOrThrow({ where: { id: A.jobId } }))).currentVisitNumber).toBe(1);
    await rejects(A, /job_current_visit_positive/, (tx) => tx.job.update({ where: { id: A.jobId }, data: { currentVisitNumber: 0 } }));
    await expect(
      withTenant(A.tenantId, (tx) => tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, visitNumber: 901, outcome: "SOLD", paymentStatus: "REFUSED" } })),
    ).resolves.toBeDefined();
  });
});
