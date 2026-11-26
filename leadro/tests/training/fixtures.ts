import { expect } from "vitest";
import { localIsoDate } from "@/lib/zoned-time";
import { POST as createCourse } from "@/app/api/v1/training/courses/route";
import { POST as assign } from "@/app/api/v1/training/assignments/route";
import { POST as recordCompletion } from "@/app/api/v1/training/records/route";
import { POST as verify } from "@/app/api/v1/training/records/[id]/verify/route";
import { withTenant } from "@/server/db";
import { createPerson, grantTemplate, makeRole, type World } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

/** Shared helpers of the training tests: courses, certifications, the tenant's calendar, notifications. */

export const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;

export async function tenantToday(tenantId: string, offsetDays = 0): Promise<string> {
  const tenant = await withTenant(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } }));
  return localIsoDate(Date.now() + offsetDays * 86_400_000, tenant.defaultTimeZone);
}

export const newTrainingCertification = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.certification.create({ data: { tenantId, code: unique("tc"), name: "Safety card", type: "TRAINING" } }));

export async function newCourse(cookie: string, extra: Record<string, unknown> = {}) {
  const code = unique("course").toLowerCase();
  const result = await call(createCourse, "POST", "/x", { cookie, body: { code, name: `Course ${code}`, ...extra } });
  expect(result.status).toBe(201);
  return result.json.data as { id: string; code: string; certificationId: string | null; validityDays: number | null };
}

export const assignCourse = (cookie: string, body: Record<string, unknown>) => call(assign, "POST", "/x", { cookie, body });
export const recordCourse = (cookie: string, body: Record<string, unknown>) => call(recordCompletion, "POST", "/x", { cookie, body });
export const verifyRecord = (cookie: string, id: string) => call(verify, "POST", "/x", { cookie, params: { id }, body: {} });

/** An HR-like approver who is also an employee (to prove nobody decides on their own record). */
export async function selfApprover(w: World) {
  const roleId = await makeRole(w.tenantId, "training self approver", [
    { permission: "training.view" },
    { permission: "training.create" },
    { permission: "training.approve" },
  ]);
  const person = await createPerson(w.tenantId, "training-self", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, person, roleId, [{ type: "TENANT" }]);
  return { cookie: await sessionCookie(person, w.tenantId), employeeId: person.employeeId as string };
}

/** Notifications of one event about one record held by a user. */
export const notificationsOf = (tenantId: string, userId: string, eventType: string, targetId: string) =>
  withTenant(tenantId, (tx) => tx.notification.findMany({ where: { tenantId, recipientId: userId, eventType, targetId } }));
