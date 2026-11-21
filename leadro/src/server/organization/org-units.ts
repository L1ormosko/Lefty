import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, projectFields } from "@/server/authz";
import {
  conflictOnUniqueViolation,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  type Actor,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import { ORG_UNIT_FIELD_MAP, ORG_UNIT_SELECT } from "./fields";
import {
  assertActive,
  assertBranchAttributesAllowed,
  assertLegalEntityUsable,
  assertParentAllowed,
  assertSiblingNameFree,
  toUnitUpdateData,
} from "./org-unit-rules";
import type { ArchiveInput, CreateOrgUnitInput, MoveOrgUnitInput, UpdateOrgUnitInput } from "./schemas";
import { lockOrgTree, subtreeIds } from "./tree-lock";

/**
 * Structural writes on the org tree (§3.2, §3.3). Every function runs in ONE transaction that
 * (1) takes the per-tenant tree lock, (2) checks permission AND data scope with `enforceInTx`,
 * (3) validates the business state, (4) writes, (5) records the audit event.
 *
 * Moving or archiving a unit changes who can see what on the very next request, because authz
 * expands scopes over the tree as it is now. Historical placements are untouched.
 */

type PartialUnit = Partial<Prisma.OrgUnitGetPayload<{ select: typeof ORG_UNIT_SELECT }>>;

/**
 * Creates an org unit under `parentId` (or at the top). Needs `organization.create` over the PARENT
 * unit (a top-level unit needs a tenant-wide grant). The type must be allowed under the parent's
 * type (`src/lib/org-hierarchy.ts`) and the parent must be active.
 */
export async function createOrgUnit(actor: Actor, ctx: RequestContext, input: CreateOrgUnitInput): Promise<PartialUnit> {
  assertBranchAttributesAllowed(input.type, input);
  return conflictOnUniqueViolation("The unit conflicts with an existing one.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await lockOrgTree(tx, actor.tenantId);
      const parentId = input.parentId ?? null;
      const decision = await enforceInTx(tx, actor, "organization.create", parentId ? { orgUnitId: parentId } : {});

      const parent = parentId
        ? await tx.orgUnit.findFirst({ where: { id: parentId, tenantId: actor.tenantId }, select: { type: true, active: true } })
        : null;
      if (parentId && !parent) throw new NotFoundError();
      if (parent) assertActive(parent, "A unit cannot be created under an archived unit.");
      assertParentAllowed(input.type, parent);
      await assertSiblingNameFree(tx, actor.tenantId, parentId, input.name);
      await assertLegalEntityUsable(tx, actor.tenantId, input.legalEntityId);

      const unit = await tx.orgUnit.create({
        data: {
          tenantId: actor.tenantId,
          type: input.type,
          name: input.name,
          code: input.code,
          parentId,
          legalEntityId: input.legalEntityId ?? null,
          address: input.address,
          timeZone: input.timeZone,
          defaultLocale: input.defaultLocale,
          operatingHours: input.operatingHours,
        },
        select: ORG_UNIT_SELECT,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "org_unit.create",
        targetType: "OrgUnit",
        targetId: unit.id,
        newValue: unit,
      });
      return projectFields(unit, decision, ORG_UNIT_FIELD_MAP);
    }),
  );
}

/**
 * Renames a unit and edits its attributes (code, legal entity, branch details). The type is fixed.
 * Needs `organization.edit` over the unit; an archived unit is read-only.
 */
export async function updateOrgUnit(
  actor: Actor,
  ctx: RequestContext,
  unitId: string,
  input: UpdateOrgUnitInput,
): Promise<PartialUnit> {
  return conflictOnUniqueViolation("The unit conflicts with an existing one.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await lockOrgTree(tx, actor.tenantId); // sibling-name check must not race with moves
      const decision = await enforceInTx(tx, actor, "organization.edit", { orgUnitId: unitId });
      const unit = await tx.orgUnit.findFirst({ where: { id: unitId, tenantId: actor.tenantId }, select: ORG_UNIT_SELECT });
      if (!unit) throw new NotFoundError();
      assertActive(unit, "An archived unit cannot be edited.");
      assertBranchAttributesAllowed(unit.type, input);

      const { changedKeys, previous, next } = changedFields(unit, input);
      if (changedKeys.length === 0) return projectFields(unit, decision, ORG_UNIT_FIELD_MAP);
      if (input.name !== undefined) await assertSiblingNameFree(tx, actor.tenantId, unit.parentId, input.name, unit.id);
      if (input.legalEntityId !== undefined) await assertLegalEntityUsable(tx, actor.tenantId, input.legalEntityId);

      const updated = await tx.orgUnit.update({
        where: { id: unit.id },
        data: toUnitUpdateData(input),
        select: ORG_UNIT_SELECT,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "org_unit.update",
        targetType: "OrgUnit",
        targetId: unit.id,
        previousValue: previous,
        newValue: next,
      });
      return projectFields(updated, decision, ORG_UNIT_FIELD_MAP);
    }),
  );
}

/**
 * Re-parents a unit (and so its whole subtree). Needs `organization.edit` over the unit AND over
 * the destination (you cannot push a unit into a place you have no authority over; a move to the top
 * needs a tenant-wide grant).
 *
 * Refused when: the destination is the unit itself or one of its descendants (cycle, checked on
 * the live tree under the tree lock; the database trigger is only the backstop), the destination is
 * archived, the unit is archived, or the type is not allowed under the new parent.
 */
export async function moveOrgUnit(
  actor: Actor,
  ctx: RequestContext,
  unitId: string,
  input: MoveOrgUnitInput,
): Promise<PartialUnit> {
  return withTenant(actor.tenantId, async (tx) => {
    await lockOrgTree(tx, actor.tenantId);
    const decision = await enforceInTx(tx, actor, "organization.edit", { orgUnitId: unitId });
    const newParentId = input.newParentId;
    await enforceInTx(tx, actor, "organization.edit", newParentId ? { orgUnitId: newParentId } : {});

    const unit = await tx.orgUnit.findFirst({ where: { id: unitId, tenantId: actor.tenantId }, select: ORG_UNIT_SELECT });
    if (!unit) throw new NotFoundError();
    assertActive(unit, "An archived unit cannot be moved.");
    if (unit.parentId === newParentId) {
      throw new ValidationError({ message: "The unit is already under this parent.", field: "newParentId" });
    }

    const newParent = newParentId
      ? await tx.orgUnit.findFirst({ where: { id: newParentId, tenantId: actor.tenantId }, select: { type: true, active: true } })
      : null;
    if (newParentId && !newParent) throw new NotFoundError();
    if (newParent) assertActive(newParent, "A unit cannot be moved under an archived unit.");
    if (newParentId && (await subtreeIds(tx, actor.tenantId, unit.id)).includes(newParentId)) {
      throw new ValidationError({ message: "A unit cannot be moved under itself or one of its descendants.", field: "newParentId" });
    }
    assertParentAllowed(unit.type, newParent);
    await assertSiblingNameFree(tx, actor.tenantId, newParentId, unit.name, unit.id);

    const moved = await tx.orgUnit.update({ where: { id: unit.id }, data: { parentId: newParentId }, select: ORG_UNIT_SELECT });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "org_unit.move",
      targetType: "OrgUnit",
      targetId: unit.id,
      previousValue: { parentId: unit.parentId },
      newValue: { parentId: newParentId },
      reason: input.reason,
    });
    return projectFields(moved, decision, ORG_UNIT_FIELD_MAP);
  });
}

/**
 * Archives a unit (soft: nothing is deleted, history keeps pointing at it). Needs
 * `organization.archive` over the unit. Refused while it still has active child units or people
 * currently placed in it, so an archive can never silently orphan a subtree or hide employees from
 * their managers. Open manager assignments are ended.
 */
export async function archiveOrgUnit(
  actor: Actor,
  ctx: RequestContext,
  unitId: string,
  input: ArchiveInput,
): Promise<PartialUnit> {
  return withTenant(actor.tenantId, async (tx) => {
    await lockOrgTree(tx, actor.tenantId);
    const decision = await enforceInTx(tx, actor, "organization.archive", { orgUnitId: unitId });
    // Employee placement takes a FOR SHARE lock on the unit row (employees/lockUnitShared). Taking
    // FOR UPDATE here waits for in-flight placements to commit, so the placement count below
    // cannot miss one, and later placements see the unit as archived.
    await tx.$queryRaw`SELECT id FROM "OrgUnit" WHERE id = ${unitId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    const unit = await tx.orgUnit.findFirst({ where: { id: unitId, tenantId: actor.tenantId }, select: ORG_UNIT_SELECT });
    if (!unit) throw new NotFoundError();
    assertActive(unit, "The unit is already archived.");

    const now = new Date();
    const [activeChildren, currentPlacements] = await Promise.all([
      tx.orgUnit.count({ where: { tenantId: actor.tenantId, parentId: unit.id, active: true } }),
      tx.organizationalAssignment.count({
        where: {
          tenantId: actor.tenantId,
          orgUnitId: unit.id,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
      }),
    ]);
    if (activeChildren > 0) {
      throw new InvalidStateTransitionError({ message: "Archive or move the unit's active child units first." });
    }
    if (currentPlacements > 0) {
      throw new InvalidStateTransitionError({ message: "Move the people currently placed in this unit first." });
    }

    const archived = await tx.orgUnit.update({ where: { id: unit.id }, data: { active: false }, select: ORG_UNIT_SELECT });
    // History stays: open manager rows are closed, never deleted. effectiveTo must be after
    // effectiveFrom (DB CHECK), hence the max().
    const openManagers = await tx.orgUnitManager.findMany({
      where: { tenantId: actor.tenantId, orgUnitId: unit.id, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      select: { id: true, effectiveFrom: true },
    });
    for (const manager of openManagers) {
      const endsAt = manager.effectiveFrom >= now ? new Date(manager.effectiveFrom.getTime() + 1) : now;
      await tx.orgUnitManager.update({ where: { id: manager.id }, data: { effectiveTo: endsAt } });
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "org_unit.archive",
      targetType: "OrgUnit",
      targetId: unit.id,
      previousValue: { active: true },
      newValue: { active: false, endedManagerAssignments: openManagers.length },
      reason: input.reason,
    });
    return projectFields(archived, decision, ORG_UNIT_FIELD_MAP);
  });
}
