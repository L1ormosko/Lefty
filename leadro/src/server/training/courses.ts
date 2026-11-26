import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { conflictOnUniqueViolation, ConflictError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, ValidationError, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { enforceCatalogManage, lockRow } from "./access";
import type { ArchiveCourseInput, CreateCourseInput, ListCoursesQuery, UpdateCourseInput } from "./schemas";
import { toCourseView, type CourseView } from "./views";

/**
 * The training course catalog (§10.1 "Training", §5.8): code, name, category, validity, and optionally the TRAINING-type
 * certification a verified completion grants. Tenant-wide reference data: any `training.view` grant reads it, changes need
 * `training.manage` at TENANT scope. A course is never deleted (assignments and records reference it); archiving takes it
 * out of the active catalog (no new assignments) and keeps its history.
 */

const DUPLICATE_CODE = "A course with this code already exists.";

/** The certification must exist, be of type TRAINING (the composite FK pins this too) and be active. */
async function assertTrainingCertification(tx: TenantTx, tenantId: string, certificationId: string): Promise<void> {
  const certification = await tx.certification.findFirst({ where: { id: certificationId, tenantId }, select: { type: true, active: true } });
  if (!certification) throw new ValidationError({ message: "Unknown certification.", field: "certificationId" });
  if (certification.type !== "TRAINING") throw new ValidationError({ message: "A course can only grant a training certification.", field: "certificationId" });
  if (!certification.active) throw new ValidationError({ message: "This certification is retired.", field: "certificationId" });
}

/** `GET /training/courses`: the catalog by code (active only unless `includeArchived`). */
export async function listCourses(actor: Actor, query: ListCoursesQuery): Promise<Page<CourseView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const where: Prisma.TrainingCourseWhereInput = {
      tenantId: actor.tenantId,
      ...(query.includeArchived ? {} : { active: true }),
      ...(query.category ? { category: query.category } : {}),
      ...(query.certificationId ? { certificationId: query.certificationId } : {}),
      ...(query.q ? { OR: [{ code: { contains: query.q, mode: "insensitive" } }, { name: { contains: query.q, mode: "insensitive" } }] } : {}),
    };
    const rows = await tx.trainingCourse.findMany({ where, orderBy: [{ code: "asc" }, { id: "asc" }], ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toCourseView), page: page.page };
  });
}

/** `GET /training/courses/{id}`. @throws ForbiddenError, NotFoundError */
export async function getCourse(actor: Actor, courseId: string): Promise<CourseView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const row = await tx.trainingCourse.findFirst({ where: { id: courseId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    return toCourseView(row);
  });
}

/** `POST /training/courses`. The code is unique per tenant (409) and fixed from then on. */
export async function createCourse(actor: Actor, ctx: RequestContext, input: CreateCourseInput): Promise<CourseView> {
  return conflictOnUniqueViolation(DUPLICATE_CODE, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceCatalogManage(tx, actor);
      const taken = await tx.trainingCourse.findFirst({ where: { tenantId: actor.tenantId, code: input.code }, select: { id: true } });
      if (taken) throw new ConflictError({ message: DUPLICATE_CODE, field: "code" });
      if (input.certificationId) await assertTrainingCertification(tx, actor.tenantId, input.certificationId);
      const row = await tx.trainingCourse.create({
        data: {
          tenantId: actor.tenantId,
          code: input.code,
          name: input.name,
          category: input.category ?? null,
          description: input.description ?? null,
          certificationId: input.certificationId ?? null,
          validityDays: input.validityDays ?? null,
          createdById: actor.userId,
        },
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "training_course.create",
        targetType: "TrainingCourse",
        targetId: row.id,
        newValue: { code: row.code, name: row.name, category: row.category, certificationId: row.certificationId, validityDays: row.validityDays },
      });
      return toCourseView(row);
    }),
  );
}

/**
 * `PATCH /training/courses/{id}`. A new validity applies to completions recorded afterwards; existing records keep the
 * expiry computed when they were recorded. An archived course cannot change.
 */
export async function updateCourse(actor: Actor, ctx: RequestContext, courseId: string, input: UpdateCourseInput): Promise<CourseView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceCatalogManage(tx, actor);
    await lockRow(tx, "TrainingCourse", actor.tenantId, courseId);
    const before = await tx.trainingCourse.findFirstOrThrow({ where: { id: courseId, tenantId: actor.tenantId } });
    if (!before.active) throw new InvalidStateTransitionError({ message: "The course is archived." });
    if (input.certificationId) await assertTrainingCertification(tx, actor.tenantId, input.certificationId);
    const { changedKeys, previous, next } = changedFields(before, input);
    if (changedKeys.length === 0) return toCourseView(before);
    const row = await tx.trainingCourse.update({
      where: { id: courseId },
      data: { name: input.name, category: input.category, description: input.description, certificationId: input.certificationId, validityDays: input.validityDays },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "training_course.update", targetType: "TrainingCourse", targetId: row.id, previousValue: previous, newValue: next });
    return toCourseView(row);
  });
}

/**
 * `POST /training/courses/{id}/archive`: no new assignments for this course. Open assignments stay open (they can still be
 * completed or cancelled), recorded completions and granted qualifications are untouched.
 * @throws InvalidStateTransitionError when already archived
 */
export async function archiveCourse(actor: Actor, ctx: RequestContext, courseId: string, input: ArchiveCourseInput): Promise<CourseView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceCatalogManage(tx, actor);
    await lockRow(tx, "TrainingCourse", actor.tenantId, courseId);
    const before = await tx.trainingCourse.findFirstOrThrow({ where: { id: courseId, tenantId: actor.tenantId } });
    if (!before.active) throw new InvalidStateTransitionError({ message: "The course is already archived." });
    const row = await tx.trainingCourse.update({ where: { id: courseId }, data: { active: false, archivedAt: new Date() } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_course.archive",
      targetType: "TrainingCourse",
      targetId: row.id,
      previousValue: { active: true },
      newValue: { active: false },
      reason: input.reason,
    });
    return toCourseView(row);
  });
}
