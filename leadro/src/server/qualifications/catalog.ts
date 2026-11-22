import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import {
  conflictOnUniqueViolation,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import type {
  CreateCertificationInput,
  CreateSkillInput,
  ListCatalogQuery,
  ListCertificationsQuery,
  UpdateCertificationInput,
  UpdateSkillInput,
} from "./schemas";
import { toCertificationView, toSkillView } from "./views";

/**
 * The skill and certification catalogs (§10.1). Reading needs any `qualifications.view` grant (the
 * catalog is company-wide reference data, like job types); changing it needs `qualifications.manage`
 * with a TENANT scope. Entries are never deleted: `active: false` retires one (existing employee
 * records and job requirements keep pointing at it).
 */

const DUPLICATE_SKILL = "A skill with this code already exists.";
const DUPLICATE_CERTIFICATION = "A certification with this code already exists.";

export async function listSkills(actor: Actor, query: ListCatalogQuery): Promise<Page<ReturnType<typeof toSkillView>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const where: Prisma.SkillWhereInput = { tenantId: actor.tenantId, ...(query.active === undefined ? {} : { active: query.active }) };
    const rows = await tx.skill.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toSkillView), page: page.page };
  });
}

export async function createSkill(actor: Actor, ctx: RequestContext, input: CreateSkillInput) {
  return conflictOnUniqueViolation(DUPLICATE_SKILL, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "qualifications.manage", {});
      const skill = await tx.skill.create({ data: { tenantId: actor.tenantId, ...input } });
      await recordAudit(tx, { ...auditContextFields(ctx), action: "skill.create", targetType: "Skill", targetId: skill.id, newValue: input });
      return toSkillView(skill);
    }),
  );
}

export async function updateSkill(actor: Actor, ctx: RequestContext, skillId: string, input: UpdateSkillInput) {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.manage", {});
    const skill = await tx.skill.findFirst({ where: { id: skillId, tenantId: actor.tenantId } });
    if (!skill) throw new NotFoundError();
    const { changedKeys, previous, next } = changedFields(skill, input);
    if (changedKeys.length === 0) return toSkillView(skill);
    const updated = await tx.skill.update({ where: { id: skill.id }, data: input });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "skill.update", targetType: "Skill", targetId: skill.id, previousValue: previous, newValue: next });
    return toSkillView(updated);
  });
}

export async function listCertifications(actor: Actor, query: ListCertificationsQuery): Promise<Page<ReturnType<typeof toCertificationView>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const where: Prisma.CertificationWhereInput = {
      tenantId: actor.tenantId,
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.type ? { type: query.type } : {}),
    };
    const rows = await tx.certification.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toCertificationView), page: page.page };
  });
}

export async function createCertification(actor: Actor, ctx: RequestContext, input: CreateCertificationInput) {
  return conflictOnUniqueViolation(DUPLICATE_CERTIFICATION, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "qualifications.manage", {});
      const certification = await tx.certification.create({ data: { tenantId: actor.tenantId, ...input } });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "certification.create",
        targetType: "Certification",
        targetId: certification.id,
        newValue: input,
      });
      return toCertificationView(certification);
    }),
  );
}

export async function updateCertification(actor: Actor, ctx: RequestContext, certificationId: string, input: UpdateCertificationInput) {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.manage", {});
    const certification = await tx.certification.findFirst({ where: { id: certificationId, tenantId: actor.tenantId } });
    if (!certification) throw new NotFoundError();
    const { changedKeys, previous, next } = changedFields(certification, input);
    if (changedKeys.length === 0) return toCertificationView(certification);
    const updated = await tx.certification.update({ where: { id: certification.id }, data: input });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "certification.update",
      targetType: "Certification",
      targetId: certification.id,
      previousValue: previous,
      newValue: next,
    });
    return toCertificationView(updated);
  });
}
