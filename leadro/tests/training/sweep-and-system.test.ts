import { afterAll, beforeAll, describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { conflictOnUniqueViolation } from "@/server/core";
import { withTenant } from "@/server/db";
import { NOTIFICATION_EVENTS } from "@/server/notifications";
import {
  createTrainingAssignmentInTx,
  findOverdueTrainingAssignments,
  sweepTraining,
  TRAINING_ASSIGNMENT_ALREADY_OPEN,
  TRAINING_ASSIGNMENT_STATUSES,
  TRAINING_RECORD_STATUSES,
} from "@/server/training";
import { buildWorld, disconnect, toActor, type World } from "../authz/fixtures";
import { contextFor, sessionCookie } from "../org/org-helpers";
import { assignCourse, newCourse, notificationsOf, recordCourse, tenantToday, verifyRecord } from "./fixtures";

let w: World;
let hr: string;

beforeAll(async () => {
  w = await buildWorld("trainsweep");
  hr = await sessionCookie(w.hr, w.tenantId);
});
afterAll(disconnect);

const dateColumn = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);

describe("sweepTraining", () => {
  it("notifies an overdue assignment to the employee and the assigner, once per due date", async () => {
    const course = await newCourse(hr);
    const assignment = (await assignCourse(hr, { employeeId: w.techA1.employeeId, courseId: course.id })).json.data;
    // Due dates in the past can only arise because time passed: set one in the database.
    await withTenant(w.tenantId, (tx) => tx.trainingAssignment.update({ where: { id: assignment.id }, data: { dueDate: dateColumn("2026-01-10") } }));

    const overdue = await withTenant(w.tenantId, (tx) => findOverdueTrainingAssignments(tx, w.tenantId));
    expect(overdue.map((row) => row.assignmentId)).toContain(assignment.id);

    const first = await sweepTraining(w.tenantId);
    expect(first.overdue).toBeGreaterThanOrEqual(2);
    expect(await notificationsOf(w.tenantId, w.techA1.userId, "training.overdue", assignment.id)).toHaveLength(1);
    expect(await notificationsOf(w.tenantId, w.hr.userId, "training.overdue", assignment.id)).toHaveLength(1);

    const again = await sweepTraining(w.tenantId);
    expect(again.overdue).toBe(0);

    // A new due date is a new occurrence.
    await withTenant(w.tenantId, (tx) => tx.trainingAssignment.update({ where: { id: assignment.id }, data: { dueDate: dateColumn("2026-01-11") } }));
    expect((await sweepTraining(w.tenantId)).overdue).toBe(2);
  });

  it("notifies the employee of a verified completion that expires soon, and once it expired; superseded or pending ones never", async () => {
    const course = await newCourse(hr, { validityDays: 3 });
    const record = (await recordCourse(hr, { employeeId: w.techB.employeeId, courseId: course.id, completedAt: new Date().toISOString() })).json.data;
    const pending = (await recordCourse(hr, { employeeId: w.techA1Other.employeeId, courseId: course.id, completedAt: new Date().toISOString() })).json.data;
    await verifyRecord(hr, record.id);

    await sweepTraining(w.tenantId);
    expect(await notificationsOf(w.tenantId, w.techB.userId, "training.expiring", record.id)).toHaveLength(1);
    expect(await notificationsOf(w.tenantId, w.techA1Other.userId, "training.expiring", pending.id)).toHaveLength(0);
    await sweepTraining(w.tenantId);
    expect(await notificationsOf(w.tenantId, w.techB.userId, "training.expiring", record.id)).toHaveLength(1);

    // Four days later it has expired.
    await sweepTraining(w.tenantId, new Date(Date.now() + 4 * 86_400_000));
    expect(await notificationsOf(w.tenantId, w.techB.userId, "training.expired", record.id)).toHaveLength(1);
    // Long after the look-back window nothing new is raised.
    const late = await sweepTraining(w.tenantId, new Date(Date.now() + 60 * 86_400_000));
    expect(late.expired).toBe(0);
  });

  it("does not warn about a completion a longer-lasting one supersedes", async () => {
    const shortCourse = await newCourse(hr, { validityDays: 2 });
    const record = (await recordCourse(hr, { employeeId: w.techA1Other.employeeId, courseId: shortCourse.id, completedAt: new Date(Date.now() - 86_400_000).toISOString() })).json.data;
    await verifyRecord(hr, record.id);
    const renewal = (await recordCourse(hr, { employeeId: w.techA1Other.employeeId, courseId: shortCourse.id, completedAt: new Date().toISOString() })).json.data;
    await verifyRecord(hr, renewal.id);
    await sweepTraining(w.tenantId);
    expect(await notificationsOf(w.tenantId, w.techA1Other.userId, "training.expiring", record.id)).toHaveLength(0);
    expect(await notificationsOf(w.tenantId, w.techA1Other.userId, "training.expiring", renewal.id)).toHaveLength(1);
  });
});

describe("createTrainingAssignmentInTx (for Task 5)", () => {
  it("creates a RECOMMENDATION assignment linked to the recommendation, and refuses a second open one", async () => {
    const course = await newCourse(hr);
    const employeeId = w.techB.employeeId as string;
    const recommendation = await withTenant(w.tenantId, (tx) =>
      tx.trainingRecommendation.create({ data: { tenantId: w.tenantId, employeeId, courseId: course.id, reasons: [{ code: "test_reason" }] } }),
    );
    const ctx = contextFor(toActor(w.tenantId, w.cityManagerB.userId, w.cityManagerB.employeeId));
    const dueDate = await tenantToday(w.tenantId, 7);
    const result = await withTenant(w.tenantId, (tx) =>
      createTrainingAssignmentInTx(tx, ctx, { employeeId, courseId: course.id, dueDate, source: "RECOMMENDATION", recommendationId: recommendation.id }),
    );
    expect(result.assignment).toMatchObject({ source: "RECOMMENDATION", recommendationId: recommendation.id, dueDate, assignedById: w.cityManagerB.userId });
    expect(result.notificationIds).toHaveLength(1);

    await expect(
      conflictOnUniqueViolation(TRAINING_ASSIGNMENT_ALREADY_OPEN, () =>
        withTenant(w.tenantId, (tx) => createTrainingAssignmentInTx(tx, ctx, { employeeId, courseId: course.id, source: "MANUAL" })),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      withTenant(w.tenantId, (tx) => createTrainingAssignmentInTx(tx, ctx, { employeeId, courseId: course.id, source: "RECOMMENDATION" })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("training labels", () => {
  const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };
  const trainingEvents = Object.entries(NOTIFICATION_EVENTS).filter(([type]) => type.startsWith("training."));
  const expectedKeys = [
    ...TRAINING_ASSIGNMENT_STATUSES.map((status) => `TRAINING.ASSIGNMENT_STATUS.${status}`),
    ...TRAINING_RECORD_STATUSES.map((status) => `TRAINING.RECORD_STATUS.${status}`),
    ...trainingEvents.flatMap(([, event]) => [`${event.templateKey}.TITLE`, `${event.templateKey}.BODY`]),
  ];

  it("registers the four training notification events", () => {
    expect(trainingEvents.map(([type]) => type).sort()).toEqual(["training.assigned", "training.expired", "training.expiring", "training.overdue"]);
  });

  it.each(Object.keys(catalogs))("%s has every training label", (locale) => {
    for (const key of expectedKeys) expect(catalogs[locale], key).toHaveProperty([key]);
  });
});
