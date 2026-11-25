import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { cancelApprovalForSubjectInTx } from "@/server/approvals";
import { auditContextFields, recordAudit } from "@/server/audit";
import type { AccessDecision } from "@/server/authz";
import { conflictOnUniqueViolation, ConflictError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { enforceCatalogPermission, enforceMaterialsView, lockMaterial } from "./access";
import { MATERIAL_COST_SUBJECT, endPendingVersionInTx, pendingVersion } from "./cost-versions";
import { costVersionRowSelect, materialRowSelect, materialView, type CostVersionRow, type MaterialRow } from "./fields";
import type { ArchiveMaterialInput, CreateMaterialInput, ListMaterialsQuery, UpdateMaterialInput } from "./schemas";

/**
 * The material catalog (spec 11.4): material id, code, name, unit, supplier, active status. Tenant-wide reference data:
 * reading is the `materials.view` capability; create / edit / archive need the permission at TENANT scope. A material is
 * never deleted (usages and versions reference it); it is archived, which stops new costs but keeps its history and lets
 * past usage still be costed.
 */

const DUPLICATE_CODE = "A material with this code already exists.";

/** Current (approved, in effect at `now`) and pending versions of the given materials. */
async function costsFor(tx: TenantTx, tenantId: string, materialIds: string[], now: Date): Promise<Map<string, { current: CostVersionRow | null; pending: CostVersionRow | null }>> {
  const versions = await tx.materialCostVersion.findMany({
    where: {
      tenantId,
      materialId: { in: materialIds },
      OR: [
        { status: "PENDING_APPROVAL" },
        { status: "APPROVED", effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      ],
    },
    select: costVersionRowSelect,
  });
  const result = new Map(materialIds.map((id) => [id, { current: null as CostVersionRow | null, pending: null as CostVersionRow | null }]));
  for (const version of versions) {
    const entry = result.get(version.materialId);
    if (!entry) continue;
    if (version.status === "APPROVED") entry.current = version;
    else entry.pending = version;
  }
  return result;
}

async function viewOne(tx: TenantTx, row: MaterialRow, decision: Pick<AccessDecision, "allowed" | "fieldSets">): Promise<Record<string, unknown>> {
  const costs = (await costsFor(tx, row.tenantId, [row.id], new Date())).get(row.id) ?? { current: null, pending: null };
  return materialView(row, costs, decision);
}

/** `GET /materials`: the catalog by code (active only unless `includeArchived`); costs only with the `cost` set. */
export async function listMaterials(actor: Actor, query: ListMaterialsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceMaterialsView(tx, actor);
    const where: Prisma.MaterialWhereInput = {
      tenantId: actor.tenantId,
      ...(query.includeArchived ? {} : { active: true }),
      ...(query.q ? { OR: [{ code: { contains: query.q, mode: "insensitive" } }, { name: { contains: query.q, mode: "insensitive" } }] } : {}),
    };
    const rows = await tx.material.findMany({ where, orderBy: [{ code: "asc" }, { id: "asc" }], select: materialRowSelect, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const costs = await costsFor(tx, actor.tenantId, page.data.map((row) => row.id), new Date());
    return { data: page.data.map((row) => materialView(row, costs.get(row.id) ?? { current: null, pending: null }, decision)), page: page.page };
  });
}

/** `GET /materials/{id}`. @throws ForbiddenError, NotFoundError */
export async function getMaterial(actor: Actor, materialId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceMaterialsView(tx, actor);
    const row = await tx.material.findFirst({ where: { id: materialId, tenantId: actor.tenantId }, select: materialRowSelect });
    if (!row) throw new NotFoundError();
    return viewOne(tx, row, decision);
  });
}

/**
 * `POST /materials`: adds a material without a cost (costs are versions: `POST /materials/{id}/costs`). The code is unique
 * per tenant (409) and fixed from then on.
 */
export async function createMaterial(actor: Actor, ctx: RequestContext, input: CreateMaterialInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceCatalogPermission(tx, actor, "materials.create");
    const decision = await enforceMaterialsView(tx, actor);
    const taken = await tx.material.findFirst({ where: { tenantId: actor.tenantId, code: input.code }, select: { id: true } });
    if (taken) throw new ConflictError({ message: DUPLICATE_CODE, field: "code" });
    const row = await conflictOnUniqueViolation(DUPLICATE_CODE, () =>
        tx.material.create({
          data: {
            tenantId: actor.tenantId,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            unit: input.unit,
            supplier: input.supplier ?? null,
            createdById: actor.userId,
          },
          select: materialRowSelect,
        }),
    );
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "material.create",
      targetType: "Material",
      targetId: row.id,
      newValue: { code: row.code, name: row.name, unit: row.unit, supplier: row.supplier },
    });
    return viewOne(tx, row, decision);
  });
}

/**
 * `PATCH /materials/{id}`: name, description, supplier and unit. The unit can change only while the material has no cost
 * version and no usage linked to it: a cost is "per unit", so changing the unit under an existing cost would change what
 * that cost means (409 `material.unit_locked`).
 */
export async function updateMaterial(actor: Actor, ctx: RequestContext, materialId: string, input: UpdateMaterialInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceCatalogPermission(tx, actor, "materials.edit");
    const decision = await enforceMaterialsView(tx, actor);
    const before = await lockMaterial(tx, actor.tenantId, materialId);
    if (!before.active) throw new InvalidStateTransitionError({ message: "The material is archived." });
    const { changedKeys, previous, next } = changedFields(before, input);
    if (changedKeys.length === 0) return viewOne(tx, before, decision);
    if (changedKeys.includes("unit")) {
      const versions = await tx.materialCostVersion.count({ where: { tenantId: actor.tenantId, materialId } });
      const usages = await tx.jobMaterialUsage.count({ where: { tenantId: actor.tenantId, materialId } });
      if (versions > 0 || usages > 0) {
        throw new ConflictError({
          message: "The unit cannot change once the material has a cost or recorded usage; create a new material instead.",
          details: [{ field: "unit", code: "material.unit_locked", message: "The unit is fixed." }],
        });
      }
    }
    const row = await tx.material.update({
      where: { id: materialId },
      data: { name: input.name, description: input.description, unit: input.unit, supplier: input.supplier },
      select: materialRowSelect,
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "material.update", targetType: "Material", targetId: row.id, previousValue: previous, newValue: next });
    return viewOne(tx, row, decision);
  });
}

/**
 * `POST /materials/{id}/archive`: the material leaves the active catalog. A pending cost change is cancelled with it (the
 * version CANCELLED, its approval request cancelled). Approved versions and costed usage stay untouched.
 * @throws InvalidStateTransitionError when already archived
 */
export async function archiveMaterial(actor: Actor, ctx: RequestContext, materialId: string, input: ArchiveMaterialInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceCatalogPermission(tx, actor, "materials.archive");
    const decision = await enforceMaterialsView(tx, actor);
    const before = await lockMaterial(tx, actor.tenantId, materialId);
    if (!before.active) throw new InvalidStateTransitionError({ message: "The material is already archived." });
    const pending = await pendingVersion(tx, actor.tenantId, materialId);
    if (pending) {
      const reason = input.reason ?? "Material archived";
      await endPendingVersionInTx(tx, actor.tenantId, ctx, pending, "CANCELLED", reason, "archived");
      await cancelApprovalForSubjectInTx(tx, ctx, { tenantId: actor.tenantId, subjectType: MATERIAL_COST_SUBJECT, subjectId: pending.id, reason });
    }
    const row = await tx.material.update({ where: { id: materialId }, data: { active: false, archivedAt: new Date() }, select: materialRowSelect });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "material.archive",
      targetType: "Material",
      targetId: row.id,
      previousValue: { active: true },
      newValue: { active: false, cancelledCostVersionId: pending?.id ?? null },
      reason: input.reason,
    });
    return viewOne(tx, row, decision);
  });
}
