import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import {
  buildScopeWhere,
  enforceInTx,
  projectFields,
  projectRows,
  resolveScope,
  withinScope,
  type ScopeColumns,
} from "@/server/authz";
import {
  conflictOnUniqueViolation,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import { LEGAL_ENTITY_FIELD_MAP, LEGAL_ENTITY_SELECT, type LegalEntityRow } from "./fields";
import type {
  ArchiveInput,
  CreateLegalEntityInput,
  ListLegalEntitiesQuery,
  UpdateLegalEntityInput,
} from "./schemas";

/**
 * Legal entities (the employing companies, §3.1). They are tenant-level structure: creating,
 * editing and archiving need a TENANT-scoped `organization.*` grant. Reading needs a TENANT scope
 * or a LEGAL_ENTITY scope on that entity; org-unit scopes do not expose legal entities (the same rule
 * `can` applies to a single record, so list and detail always agree).
 */

type PartialEntity = Partial<LegalEntityRow>;

const legalEntityScopeColumns: ScopeColumns<Prisma.LegalEntityWhereInput> = {
  legalEntity: (legalEntityIds) => ({ id: { in: legalEntityIds } }),
};

const DUPLICATE_MESSAGE = "A legal entity with this name already exists.";

/** Creates a legal entity. Needs a tenant-wide `organization.create`. */
export async function createLegalEntity(
  actor: Actor,
  ctx: RequestContext,
  input: CreateLegalEntityInput,
): Promise<PartialEntity> {
  return conflictOnUniqueViolation(DUPLICATE_MESSAGE, () =>
    withTenant(actor.tenantId, async (tx) => {
      const decision = await enforceInTx(tx, actor, "organization.create", {});
      const entity = await tx.legalEntity.create({
        data: { tenantId: actor.tenantId, name: input.name, legalName: input.legalName },
        select: LEGAL_ENTITY_SELECT,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "legal_entity.create",
        targetType: "LegalEntity",
        targetId: entity.id,
        newValue: entity,
      });
      return projectFields(entity, decision, LEGAL_ENTITY_FIELD_MAP);
    }),
  );
}

/** Renames a legal entity or edits its legal name. Needs a tenant-wide `organization.edit`. */
export async function updateLegalEntity(
  actor: Actor,
  ctx: RequestContext,
  legalEntityId: string,
  input: UpdateLegalEntityInput,
): Promise<PartialEntity> {
  return conflictOnUniqueViolation(DUPLICATE_MESSAGE, () =>
    withTenant(actor.tenantId, async (tx) => {
      const decision = await enforceInTx(tx, actor, "organization.edit", {});
      const entity = await tx.legalEntity.findFirst({
        where: { id: legalEntityId, tenantId: actor.tenantId },
        select: LEGAL_ENTITY_SELECT,
      });
      if (!entity) throw new NotFoundError();
      if (!entity.active) throw new InvalidStateTransitionError({ message: "An archived legal entity cannot be edited." });

      const { changedKeys, previous, next } = changedFields(entity, input);
      if (changedKeys.length === 0) return projectFields(entity, decision, LEGAL_ENTITY_FIELD_MAP);
      const updated = await tx.legalEntity.update({ where: { id: entity.id }, data: input, select: LEGAL_ENTITY_SELECT });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "legal_entity.update",
        targetType: "LegalEntity",
        targetId: entity.id,
        previousValue: previous,
        newValue: next,
      });
      return projectFields(updated, decision, LEGAL_ENTITY_FIELD_MAP);
    }),
  );
}

/**
 * Archives a legal entity. Needs a tenant-wide `organization.archive`. Refused while active org
 * units or employees that are not terminated still reference it, so no live record is left pointing
 * at an archived employer.
 */
export async function archiveLegalEntity(
  actor: Actor,
  ctx: RequestContext,
  legalEntityId: string,
  input: ArchiveInput,
): Promise<PartialEntity> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "organization.archive", {});
    const entity = await tx.legalEntity.findFirst({
      where: { id: legalEntityId, tenantId: actor.tenantId },
      select: LEGAL_ENTITY_SELECT,
    });
    if (!entity) throw new NotFoundError();
    if (!entity.active) throw new InvalidStateTransitionError({ message: "The legal entity is already archived." });

    const [units, employees] = await Promise.all([
      tx.orgUnit.count({ where: { tenantId: actor.tenantId, legalEntityId: entity.id, active: true } }),
      tx.employee.count({
        where: { tenantId: actor.tenantId, legalEntityId: entity.id, status: { not: "TERMINATED" } },
      }),
    ]);
    if (units > 0 || employees > 0) {
      throw new InvalidStateTransitionError({
        message: "Reassign the active org units and employees of this legal entity first.",
      });
    }
    const archived = await tx.legalEntity.update({ where: { id: entity.id }, data: { active: false }, select: LEGAL_ENTITY_SELECT });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "legal_entity.archive",
      targetType: "LegalEntity",
      targetId: entity.id,
      previousValue: { active: true },
      newValue: { active: false },
      reason: input.reason,
    });
    return projectFields(archived, decision, LEGAL_ENTITY_FIELD_MAP);
  });
}

/** One page of legal entities the caller may see, ordered by name, scope-filtered and projected. */
export async function listLegalEntities(actor: Actor, query: ListLegalEntitiesQuery): Promise<Page<PartialEntity>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "organization.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "organization.view", now);
    const callerWhere: Prisma.LegalEntityWhereInput = {
      tenantId: actor.tenantId,
      ...(query.active === "all" ? {} : { active: query.active === "true" }),
    };
    const rows = await tx.legalEntity.findMany({
      where: withinScope(buildScopeWhere(scope, legalEntityScopeColumns, now), callerWhere),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: LEGAL_ENTITY_SELECT,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const projected = projectRows(page.data, scope, LEGAL_ENTITY_FIELD_MAP, (row) => ({ legalEntityIds: [row.id] }));
    return { data: projected, page: page.page };
  });
}

/** One legal entity (`organization.view` over it); outside the caller's scope it is a 404. */
export async function getLegalEntity(actor: Actor, legalEntityId: string): Promise<PartialEntity> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "organization.view", { legalEntityId });
    const entity = await tx.legalEntity.findFirst({
      where: { id: legalEntityId, tenantId: actor.tenantId },
      select: LEGAL_ENTITY_SELECT,
    });
    if (!entity) throw new NotFoundError();
    return projectFields(entity, decision, LEGAL_ENTITY_FIELD_MAP);
  });
}
