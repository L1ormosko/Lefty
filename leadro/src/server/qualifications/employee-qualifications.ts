import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { VERIFIED_FACT_FIELDS } from "@/lib/qualification-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import {
  conflictOnUniqueViolation,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  ValidationError,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { CreateQualificationInput, ListQualificationsQuery, UpdateQualificationInput } from "./schemas";
import { employeesWithVisiblePrivateFields } from "./reveal";
import { assertBaseFields, maskCredentialNumber, qualificationScopeColumns, toQualificationView, type QualificationView } from "./views";

/**
 * An employee's skills and credentials (§10.1): create, edit, read, list. Verification (HR) is in
 * `verification.ts`. All of it is scoped by the EMPLOYEE's data scope: `qualifications.create/edit`
 * over the employee to record, `qualifications.view` to read.
 *
 * A new record starts PENDING_VERIFICATION and only counts for eligibility once HR verifies it.
 */

/** Audit values of a change: the credential number, if present, is masked. */
function maskNumberChange(values: Record<string, unknown>): Record<string, unknown> {
  return "number" in values ? { ...values, number: maskCredentialNumber((values.number as string | null) ?? null) } : values;
}

const DUPLICATE_SKILL = "This employee already has this skill recorded. Edit the existing record instead.";

/** Employees who left (or are leaving) get no new records; their history stays readable. */
async function loadEditableEmployee(tx: TenantTx, tenantId: string, employeeId: string) {
  const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, status: true } });
  if (!employee) throw new NotFoundError();
  if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee's qualifications cannot be changed." });
  return employee;
}

/** Records a skill or credential for an employee. Skills need an active catalog skill; credentials an active certification. */
export async function createQualification(actor: Actor, ctx: RequestContext, input: CreateQualificationInput): Promise<QualificationView> {
  return conflictOnUniqueViolation(DUPLICATE_SKILL, () =>
    withTenant(actor.tenantId, async (tx) => {
      const decision = await enforceInTx(tx, actor, "qualifications.create", { employeeId: input.employeeId });
      assertBaseFields(decision);
      await loadEditableEmployee(tx, actor.tenantId, input.employeeId);

      let kind: "SKILL" | "CERTIFICATION" | "LICENSE" | "EQUIPMENT" | "TRAINING" = "SKILL";
      if (input.skillId) {
        const skill = await tx.skill.findFirst({ where: { id: input.skillId, tenantId: actor.tenantId } });
        if (!skill) throw new ValidationError({ message: "Unknown skill.", field: "skillId" });
        if (!skill.active) throw new ValidationError({ message: "This skill is retired.", field: "skillId" });
      } else if (input.certificationId) {
        const certification = await tx.certification.findFirst({ where: { id: input.certificationId, tenantId: actor.tenantId } });
        if (!certification) throw new ValidationError({ message: "Unknown certification.", field: "certificationId" });
        if (!certification.active) throw new ValidationError({ message: "This certification is retired.", field: "certificationId" });
        if (certification.requiresNumber && !input.number) {
          throw new ValidationError({ message: "This credential requires its number.", field: "number" });
        }
        // The composite FK (certificationId, kind) -> Certification (id, type) makes the DB enforce this.
        kind = certification.type;
      }

      const row = await tx.employeeQualification.create({
        data: {
          tenantId: actor.tenantId,
          employeeId: input.employeeId,
          kind,
          skillId: input.skillId,
          certificationId: input.certificationId,
          level: input.level,
          number: input.number,
          issuingAuthority: input.issuingAuthority,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
          notes: input.notes,
          status: "PENDING_VERIFICATION",
        },
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "qualification.create",
        targetType: "EmployeeQualification",
        targetId: row.id,
        // Credential numbers never enter the audit log in clear (the log is readable by auditors).
        newValue: { ...input, number: maskCredentialNumber(input.number ?? null), kind, status: row.status },
      });
      return toQualificationView(row, (await employeesWithVisiblePrivateFields(tx, actor, [row.employeeId])).has(row.employeeId));
    }),
  );
}

/**
 * Edits the facts of a record. A material change to a VERIFIED row (level, number, authority, dates),
 * or any edit of a rejected / revoked row (a resubmission), returns it to PENDING_VERIFICATION and
 * clears the verifier: HR must look again. Editing notes alone keeps the verification.
 */
export async function updateQualification(
  actor: Actor,
  ctx: RequestContext,
  qualificationId: string,
  input: UpdateQualificationInput,
): Promise<QualificationView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.edit"); // capability first: a 403 must not depend on whether the id exists
    const row = await tx.employeeQualification.findFirst({ where: { id: qualificationId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "qualifications.edit", { employeeId: row.employeeId });
    assertBaseFields(decision);
    await loadEditableEmployee(tx, actor.tenantId, row.employeeId);

    if (input.level !== undefined && input.level !== null && row.kind !== "SKILL") {
      throw new ValidationError({ message: "Only skills have a level.", field: "level" });
    }
    const certification = row.certificationId
      ? await tx.certification.findFirst({ where: { id: row.certificationId, tenantId: actor.tenantId }, select: { requiresNumber: true } })
      : null;
    if (certification?.requiresNumber && input.number === null) {
      throw new ValidationError({ message: "This credential requires its number.", field: "number" });
    }
    const issuedAt = input.issuedAt === undefined ? row.issuedAt : input.issuedAt;
    const expiresAt = input.expiresAt === undefined ? row.expiresAt : input.expiresAt;
    if (issuedAt && expiresAt && expiresAt <= issuedAt) {
      throw new ValidationError({ message: "The expiry date must be after the issue date.", field: "expiresAt" });
    }

    const { changedKeys, previous, next } = changedFields(row, input);
    const revealed = (await employeesWithVisiblePrivateFields(tx, actor, [row.employeeId])).has(row.employeeId);
    if (changedKeys.length === 0) return toQualificationView(row, revealed);

    const materialChange = changedKeys.some((key) => (VERIFIED_FACT_FIELDS as readonly string[]).includes(key));
    const resubmission = row.status === "REJECTED" || row.status === "REVOKED";
    const backToPending = (row.status === "VERIFIED" && materialChange) || resubmission;

    const updated = await tx.employeeQualification.update({
      where: { id: row.id },
      data: {
        ...input,
        ...(backToPending ? { status: "PENDING_VERIFICATION", verifiedById: null, verifiedAt: null } : {}),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "qualification.update",
      targetType: "EmployeeQualification",
      targetId: row.id,
      previousValue: { ...maskNumberChange(previous), ...(backToPending ? { status: row.status } : {}) },
      newValue: { ...maskNumberChange(next), ...(backToPending ? { status: "PENDING_VERIFICATION" } : {}) },
    });
    return toQualificationView(updated, revealed);
  });
}

/** One record (`qualifications.view` over the employee); out of scope is a 404. */
export async function getQualification(actor: Actor, qualificationId: string): Promise<QualificationView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const row = await tx.employeeQualification.findFirst({ where: { id: qualificationId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "qualifications.view", { employeeId: row.employeeId });
    assertBaseFields(decision);
    return toQualificationView(row, (await employeesWithVisiblePrivateFields(tx, actor, [row.employeeId])).has(row.employeeId));
  });
}

/** Records the caller may see, newest first. The employee's data scope is part of the query. */
export async function listQualifications(actor: Actor, query: ListQualificationsQuery): Promise<Page<QualificationView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "qualifications.view", now), "base");
    const callerWhere: Prisma.EmployeeQualificationWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.skillId ? { skillId: query.skillId } : {}),
      ...(query.certificationId ? { certificationId: query.certificationId } : {}),
    };
    const rows = await tx.employeeQualification.findMany({
      where: withinScope(buildScopeWhere(scope, qualificationScopeColumns, now), callerWhere),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const revealed = await employeesWithVisiblePrivateFields(tx, actor, page.data.map((row) => row.employeeId));
    return { data: page.data.map((row) => toQualificationView(row, revealed.has(row.employeeId))), page: page.page };
  });
}
