import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import {
  computeMetricValues,
  computeMetricValuesAsSystem,
  computeValuesSchema,
  employeeValuesQuerySchema,
  getMetricValue,
  listEmployeeCurrentValues,
  listMetricValues,
  listValuesQuerySchema,
  reasonSchema,
  retireDefinition,
  updateDefinition,
  updateDefinitionSchema,
} from "@/server/performance";
import { disconnect, type Person } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { contextFor } from "../org/org-helpers";
import { at, buildPerformanceWorld, makeDefinition, makeVisit, type PerformanceWorld } from "./fixtures";

/** The tenant is in America/New_York: January 2026 is [2026-01-01T05:00Z, 2026-02-01T05:00Z). */
const JANUARY = { periodStart: "2026-01-01", periodEnd: "2026-02-01" };

let w: PerformanceWorld;
beforeAll(async () => {
  w = await buildPerformanceWorld("perf-compute");
});
afterAll(disconnect);

const compute = (person: Person, definitionId: string, employeeIds?: string[]) =>
  computeMetricValues(person.actor, contextFor(person.actor), definitionId, computeValuesSchema.parse({ ...JANUARY, ...(employeeIds ? { employeeIds } : {}) }));
const mine = (values: Array<Record<string, unknown>>, employeeId: string | null) => values.filter((value) => value.employeeId === employeeId);

async function arrival(jobId: string, employeeId: string, arrivedAt: Date, status: "RECORDED" | "PENDING_MANAGER_REVIEW" = "RECORDED"): Promise<string> {
  return withTenant(w.tenantId, async (tx) =>
    (await tx.arrivalVerification.create({
      data: { tenantId: w.tenantId, jobId, employeeId, method: "TECHNICIAN", arrivedAt, status, ...(status === "PENDING_MANAGER_REVIEW" ? { exceptionReason: "GPS_DISABLED" as const } : {}) },
    })).id,
  );
}

describe("computing each kind", () => {
  it("ON_TIME_ARRIVAL: verified arrivals at windowed jobs, per job type, with evidence and the minimum sample", async () => {
    const tech = w.techA1.employeeId as string;
    const windowEnd = at("2026-01-15T15:00:00Z");
    const ids = {
      onTime1: await arrival(await makeVisit(w, { employeeId: tech, appointmentWindowEnd: windowEnd }), tech, at("2026-01-15T14:00:00Z")),
      onTime2: await arrival(await makeVisit(w, { employeeId: tech, appointmentWindowEnd: windowEnd }), tech, windowEnd),
      late: await arrival(await makeVisit(w, { employeeId: tech, appointmentWindowEnd: windowEnd }), tech, at("2026-01-15T15:30:00Z")),
      otherType: await arrival(await makeVisit(w, { employeeId: tech, appointmentWindowEnd: windowEnd, jobTypeId: w.otherJobTypeId }), tech, at("2026-01-15T14:00:00Z")),
    };
    await arrival(await makeVisit(w, { employeeId: tech, appointmentWindowEnd: windowEnd }), tech, at("2026-01-15T14:00:00Z"), "PENDING_MANAGER_REVIEW");
    await arrival(await makeVisit(w, { employeeId: tech }), tech, at("2026-01-15T14:00:00Z")); // no appointment window
    await arrival(await makeVisit(w, { employeeId: tech, appointmentWindowEnd: windowEnd }), tech, at("2026-02-01T05:00:00Z")); // next period

    const { id } = await makeDefinition(w, { kind: "ON_TIME_ARRIVAL", minSample: 3 });
    const result = await compute(w.cityManagerA, id, [tech]);
    expect(result.employeeCount).toBe(1);
    const byType = Object.fromEntries(mine(result.values, tech).map((value) => [value.jobTypeId, value]));
    expect(byType[w.jobTypeId]).toMatchObject({ numerator: 2, denominator: 3, sampleSize: 3, enoughData: true, evidenceCount: 3, jobCategory: null });
    expect(byType[w.otherJobTypeId]).toMatchObject({ numerator: 1, denominator: 1, enoughData: false });

    const detail = await getMetricValue(w.cityManagerA.actor, byType[w.jobTypeId]?.id as string);
    expect((detail.evidenceIds as string[]).sort()).toEqual([ids.onTime1, ids.onTime2, ids.late].sort());
    expect(detail).toMatchObject({ evidenceTable: "ArrivalVerification", dimension: "TIMELINESS", periodStart: "2026-01-01", periodEnd: "2026-02-01", computedById: w.cityManagerA.userId, systemActor: null });
  });

  it("OUTCOME_CONVERSION and CUSTOMER_FEEDBACK_AVERAGE (by job category)", async () => {
    const tech = w.techA1Other.employeeId as string;
    const jobs = [await makeVisit(w, { employeeId: tech }), await makeVisit(w, { employeeId: tech }), await makeVisit(w, { employeeId: tech })];
    await withTenant(w.tenantId, async (tx) => {
      for (const [index, outcome] of (["SOLD", "NOT_SOLD", "CUSTOMER_UNAVAILABLE"] as const).entries()) {
        await tx.jobOutcome.create({ data: { tenantId: w.tenantId, jobId: jobs[index] as string, employeeId: tech, outcome, lostReasonId: outcome === "NOT_SOLD" ? w.lostReasonId : null, occurredAt: at("2026-01-20T15:00:00Z") } });
      }
      const feedback = (jobId: string, rating: number, voided = false) => ({
        tenantId: w.tenantId, jobId, customerId: w.customerId, employeeId: tech, rating, receivedAt: at("2026-01-21T15:00:00Z"), recordedById: w.ceo.userId,
        ...(voided ? { voidedAt: new Date(), voidedById: w.ceo.userId, voidReason: "Wrong job" } : {}),
      });
      await tx.customerFeedback.createMany({ data: [feedback(jobs[0] as string, 5), feedback(jobs[1] as string, 3), feedback(jobs[2] as string, 1, true)] });
    });

    const conversion = await makeDefinition(w, { kind: "OUTCOME_CONVERSION", minSample: 2 });
    const [sales] = mine((await compute(w.ceo, conversion.id, [tech])).values, tech);
    expect(sales).toMatchObject({ numerator: 1, denominator: 2, enoughData: true, jobTypeId: w.jobTypeId });

    const feedbackDefinition = await makeDefinition(w, { kind: "CUSTOMER_FEEDBACK_AVERAGE", minSample: 5, params: { breakdown: "JOB_CATEGORY" } });
    const [rating] = mine((await compute(w.ceo, feedbackDefinition.id, [tech])).values, tech);
    expect(rating).toMatchObject({ numerator: 8, denominator: 2, sampleSize: 2, enoughData: false, jobCategory: "installation", jobTypeId: null });
  });

  it("REPEAT_VISIT_RATE: same customer and job type within the window; cancelled jobs do not count", async () => {
    const tech = w.techB.employeeId as string;
    const customer = await makeCustomer(w.tenantId);
    const addressId = await makeAddress(w.tenantId, customer.id);
    const local = { ...w, customerId: customer.id, addressId };
    const repeated = await makeVisit(local, { employeeId: tech, completedAt: at("2026-01-10T15:00:00Z") });
    await makeVisit(local, { employeeId: tech, createdAt: at("2026-01-12T15:00:00Z") });
    const notRepeated = await makeVisit(local, { employeeId: tech, completedAt: at("2026-01-20T15:00:00Z") });
    await makeVisit(local, { employeeId: tech, createdAt: at("2026-01-22T15:00:00Z"), status: "CANCELLED" });
    await makeVisit(local, { employeeId: tech, createdAt: at("2026-01-23T15:00:00Z"), jobTypeId: w.otherJobTypeId });

    const { id } = await makeDefinition(w, { kind: "REPEAT_VISIT_RATE", params: { windowDays: 7 }, minSample: 1 });
    const [value] = mine((await compute(w.ceo, id, [tech])).values, tech);
    expect(value).toMatchObject({ numerator: 1, denominator: 2, jobTypeId: w.jobTypeId });
    const detail = await getMetricValue(w.ceo.actor, value?.id as string);
    expect((detail.evidenceIds as string[]).sort()).toEqual([repeated, notRepeated].sort());
  });

  it("DOCUMENTATION_COMPLETENESS: visits whose type required a form, complete when the visit's form was submitted", async () => {
    const tech = w.cityManagerB.employeeId as string;
    const formId = await withTenant(w.tenantId, async (tx) =>
      (await tx.jobCompletionFormDefinition.create({ data: { tenantId: w.tenantId, jobTypeId: w.otherJobTypeId, version: 1, status: "ACTIVE", name: "Repair form", schema: { fields: [] }, publishedAt: at("2025-12-01T00:00:00Z") } })).id,
    );
    const documented = await makeVisit(w, { employeeId: tech, completedAt: at("2026-01-15T15:00:00Z"), jobTypeId: w.otherJobTypeId });
    await makeVisit(w, { employeeId: tech, completedAt: at("2026-01-16T15:00:00Z"), jobTypeId: w.otherJobTypeId });
    await makeVisit(w, { employeeId: tech, completedAt: at("2026-01-16T15:00:00Z"), jobTypeId: w.jobTypeId }); // no form for this type
    await withTenant(w.tenantId, (tx) => tx.jobCompletion.create({ data: { tenantId: w.tenantId, jobId: documented, employeeId: tech, formDefinitionId: formId, formVersion: 1, values: {} } }));

    const { id } = await makeDefinition(w, { kind: "DOCUMENTATION_COMPLETENESS" });
    const values = mine((await compute(w.ceo, id, [tech])).values, tech);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ numerator: 1, denominator: 2, jobTypeId: w.otherJobTypeId });
  });

  it("RECOVERY_CONVERSION: cases assigned to the recovery employee, decided in the period", async () => {
    const recoveryEmployee = w.stateManager.employeeId as string;
    await withTenant(w.tenantId, async (tx) => {
      const makeCase = async (number: number, fields: Record<string, unknown>) => {
        const jobId = await makeVisit(w, { employeeId: w.techB.employeeId as string });
        const outcome = await tx.jobOutcome.create({ data: { tenantId: w.tenantId, jobId, outcome: "NOT_SOLD", lostReasonId: w.lostReasonId } });
        await tx.leadRecoveryCase.create({
          data: { tenantId: w.tenantId, number, jobOutcomeId: outcome.id, jobId, customerId: w.customerId, outcomeAt: at("2026-01-02T15:00:00Z"), presenceReason: "not_evaluated", assignedToId: recoveryEmployee, ...fields },
        });
      };
      await makeCase(1, { status: "RECOVERED", recoveredAt: at("2026-01-10T15:00:00Z") });
      await makeCase(2, { status: "CLOSED", recoveredAt: at("2026-01-11T15:00:00Z"), closedAt: at("2026-01-12T15:00:00Z") });
      await makeCase(3, { status: "NOT_RECOVERED", closedAt: at("2026-01-13T15:00:00Z") });
      await makeCase(4, { status: "CONTACTING" });
      await makeCase(5, { status: "NOT_RECOVERED", closedAt: at("2026-03-13T15:00:00Z") });
    });
    const { id } = await makeDefinition(w, { kind: "RECOVERY_CONVERSION" });
    const [value] = mine((await compute(w.ceo, id, [recoveryEmployee])).values, recoveryEmployee);
    expect(value).toMatchObject({ numerator: 2, denominator: 3 });
  });

  it("TRAINING_PROGRESS: assignments due in the period, completed / non-cancelled; sample 0 is reported", async () => {
    const tech = w.dispatcher.employeeId as string;
    const assignmentIds = await withTenant(w.tenantId, async (tx) => {
      const course = async (code: string) => (await tx.trainingCourse.create({ data: { tenantId: w.tenantId, code, name: code } })).id;
      const [c1, c2, c3, c4] = [await course("c1"), await course("c2"), await course("c3"), await course("c4")];
      const record = await tx.trainingRecord.create({ data: { tenantId: w.tenantId, employeeId: tech, courseId: c1, completedAt: at("2026-01-05T15:00:00Z"), recordedById: w.hr.userId } });
      const base = { tenantId: w.tenantId, employeeId: tech, assignedById: w.hr.userId };
      const done = await tx.trainingAssignment.create({ data: { ...base, courseId: c1, dueDate: new Date("2026-01-10"), status: "COMPLETED", completedAt: at("2026-01-05T15:00:00Z"), trainingRecordId: record.id } });
      const open = await tx.trainingAssignment.create({ data: { ...base, courseId: c2, dueDate: new Date("2026-01-31") } });
      await tx.trainingAssignment.create({ data: { ...base, courseId: c3, dueDate: new Date("2026-01-20"), status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Course withdrawn", cancelledById: w.hr.userId } });
      await tx.trainingAssignment.create({ data: { ...base, courseId: c4, dueDate: new Date("2026-02-01") } });
      return [done.id, open.id];
    });
    const { id } = await makeDefinition(w, { kind: "TRAINING_PROGRESS", minSample: 2 });
    const values = (await compute(w.ceo, id, [tech, w.techA1.employeeId as string])).values;
    expect(mine(values, tech)[0]).toMatchObject({ numerator: 1, denominator: 2, enoughData: true, jobTypeId: null, jobCategory: null });
    expect(mine(values, w.techA1.employeeId)[0]).toMatchObject({ numerator: 0, denominator: 0, sampleSize: 0, enoughData: false });
    const detail = await getMetricValue(w.ceo.actor, mine(values, tech)[0]?.id as string);
    expect((detail.evidenceIds as string[]).sort()).toEqual([...assignmentIds].sort());
  });
});

describe("scope, visibility and history", () => {
  it("a manager computes only employees in their unit (404 outside); omitted = everyone in scope", async () => {
    const { id } = await makeDefinition(w, { kind: "TRAINING_PROGRESS" });
    await expect(compute(w.cityManagerA, id, [w.techB.employeeId as string])).rejects.toMatchObject({ code: "NOT_FOUND" });
    const all = await compute(w.cityManagerA, id);
    const employees = new Set(all.values.map((value) => value.employeeId));
    expect(employees.has(w.techA1.employeeId)).toBe(true);
    expect(employees.has(w.techA1Other.employeeId)).toBe(true);
    expect(employees.has(w.techB.employeeId)).toBe(false);
    await expect(compute(w.techA1, id, [w.techA1.employeeId as string])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(compute(w.hr, id, [w.techA1.employeeId as string])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an employee sees only their own values of published definitions; drafts are previews for managers", async () => {
    const tech = w.techA1.employeeId as string;
    const draft = await makeDefinition(w, { kind: "TRAINING_PROGRESS" }, "DRAFT");
    const published = await makeDefinition(w, { kind: "TRAINING_PROGRESS" });
    const draftValue = mine((await compute(w.cityManagerA, draft.id, [tech])).values, tech)[0];
    const publishedValue = mine((await compute(w.cityManagerA, published.id, [tech, w.techA1Other.employeeId as string])).values, tech)[0];

    const own = await listEmployeeCurrentValues(w.techA1.actor, tech, employeeValuesQuerySchema.parse({}));
    const ownIds = own.map((value) => value.id);
    expect(ownIds).toContain(publishedValue?.id);
    expect(ownIds).not.toContain(draftValue?.id);
    await expect(getMetricValue(w.techA1.actor, draftValue?.id as string)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listEmployeeCurrentValues(w.techA1.actor, w.techA1Other.employeeId as string, employeeValuesQuerySchema.parse({}))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listed = await listMetricValues(w.techA1.actor, listValuesQuerySchema.parse({ limit: 200 }));
    expect(listed.data.every((value) => value.employeeId === tech && value.evidenceIds === undefined)).toBe(true);

    expect((await getMetricValue(w.cityManagerA.actor, draftValue?.id as string)).definitionStatus).toBe("DRAFT");
    await expect(getMetricValue(w.cityManagerB.actor, publishedValue?.id as string)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The COO reads values tenant-wide ("Performance: View"); the Dispatcher holds nothing (spec 10.3).
    await expect(listMetricValues(w.dispatcher.actor, listValuesQuerySchema.parse({}))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("values are append-only: a recomputation adds a snapshot and the newest is current", async () => {
    const tech = w.techA1.employeeId as string;
    const { id } = await makeDefinition(w, { kind: "TRAINING_PROGRESS" });
    const first = mine((await compute(w.ceo, id, [tech])).values, tech)[0];
    const second = mine((await compute(w.ceo, id, [tech])).values, tech)[0];
    expect(second?.id).not.toBe(first?.id);
    const current = await listEmployeeCurrentValues(w.ceo.actor, tech, employeeValuesQuerySchema.parse({ definitionId: id }));
    expect(current.map((value) => value.id)).toEqual([second?.id]);
    const history = await listMetricValues(w.ceo.actor, listValuesQuerySchema.parse({ definitionId: id }));
    expect(history.data.map((value) => value.id)).toEqual([second?.id, first?.id]);
    await expect(withTenant(w.tenantId, (tx) => tx.performanceMetricValue.update({ where: { id: first?.id as string }, data: { numerator: 0 } }))).rejects.toThrow();
  });

  it("a draft with computed values is frozen; a retired version is not computed; the system computes published ones", async () => {
    const draft = await makeDefinition(w, { kind: "TRAINING_PROGRESS" }, "DRAFT");
    await compute(w.ceo, draft.id, [w.techA1.employeeId as string]);
    await expect(updateDefinition(w.hr.actor, contextFor(w.hr.actor), draft.id, updateDefinitionSchema.parse({ minSample: 4 }))).rejects.toMatchObject({
      code: "CONFLICT",
      details: [expect.objectContaining({ code: "performance.definition_has_values" })],
    });
    await expect(computeMetricValuesAsSystem(w.tenantId, draft.id, { ...JANUARY, employeeIds: [w.techA1.employeeId as string] }, "nightly")).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await retireDefinition(w.hr.actor, contextFor(w.hr.actor), draft.id, reasonSchema.parse({ reason: "Discard" }));
    await expect(compute(w.ceo, draft.id, [w.techA1.employeeId as string])).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    const published = await makeDefinition(w, { kind: "TRAINING_PROGRESS" });
    expect(await computeMetricValuesAsSystem(w.tenantId, published.id, { ...JANUARY, employeeIds: [w.techA1.employeeId as string] }, "nightly")).toBe(1);
    const row = await withTenant(w.tenantId, (tx) => tx.performanceMetricValue.findFirstOrThrow({ where: { definitionId: published.id }, select: { systemActor: true, computedById: true, orgUnitId: true } }));
    expect(row).toEqual({ systemActor: "system:nightly", computedById: null, orgUnitId: w.units.teamA1 });
  });

  it("refuses periods that are reversed or longer than 366 days", () => {
    expect(computeValuesSchema.safeParse({ periodStart: "2026-02-01", periodEnd: "2026-01-01" }).success).toBe(false);
    expect(computeValuesSchema.safeParse({ periodStart: "2025-01-01", periodEnd: "2026-06-01" }).success).toBe(false);
  });
});
