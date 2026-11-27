import type { Prisma, SavedReportView } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { activeAssignmentWhere, buildScopeWhere, canInTx, enforceInTx, resolveScope, type ResourceRef } from "@/server/authz";
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  conflictOnUniqueViolation,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { getDataset } from "./catalog";
import { prepareReport } from "./prepare";
import type { CreateViewInput, ListViewsQuery, ReportDefinition, UpdateViewInput } from "./schemas";

/**
 * Saved report views (spec 13.5; DECISIONS "Phase 6 Task 1" contracts). A view is only a definition: whoever runs it is
 * checked with their own permissions, scope and field sets every time, so sharing never widens access.
 *
 *  - `reports.view`: list / read own views and views shared with a role the caller holds now.
 *  - `reports.create`: save views; edit and archive own views. A saved definition is validated against the dataset
 *    catalog AND against what the creator may see (no saving columns the creator cannot read).
 *  - `reports.manage`: share with / unshare from roles, read and archive other people's views "in scope": a view with an
 *    org unit filter is attributed to that unit, one without is tenant-level (TENANT scope only).
 * Views are archived, never deleted (DB trigger); owner and dataset never change (DB trigger).
 */

const NAME_TAKEN = "You already have an active view with this name.";

export interface SavedViewView {
  id: string;
  name: string;
  datasetKey: string;
  columns: string[];
  filters: Prisma.JsonValue;
  scopeOrgUnitId: string | null;
  ownerId: string;
  archivedAt: Date | null;
  archivedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Roles the view is shared with; only shown to the owner and to `reports.manage` holders over the view. */
  shares?: Array<{ roleId: string; sharedById: string; createdAt: Date }>;
}

type ViewRow = SavedReportView & { shares: Array<{ roleId: string; sharedById: string; createdAt: Date }> };

const viewInclude = { shares: { select: { roleId: true, sharedById: true, createdAt: true }, orderBy: { createdAt: "asc" } } } satisfies Prisma.SavedReportViewInclude;

function toView(row: ViewRow, showShares: boolean): SavedViewView {
  const { tenantId: _tenantId, shares, ...view } = row;
  return showShares ? { ...view, shares } : view;
}

/** `reports.manage` reference of a view: its org unit filter, or tenant-level without one. */
const viewRef = (view: Pick<SavedReportView, "scopeOrgUnitId">): ResourceRef => (view.scopeOrgUnitId ? { orgUnitId: view.scopeOrgUnitId } : {});

/** Roles the caller holds right now (active assignment of an active role). */
async function heldRoleIds(tx: TenantTx, actor: Actor, now: Date): Promise<string[]> {
  const rows = await tx.roleAssignment.findMany({
    where: { tenantId: actor.tenantId, userId: actor.userId, ...activeAssignmentWhere(now), role: { active: true } },
    select: { roleId: true },
    distinct: ["roleId"],
  });
  return rows.map((row) => row.roleId);
}

const managesView = async (tx: TenantTx, actor: Actor, view: Pick<SavedReportView, "scopeOrgUnitId">) =>
  (await canInTx(tx, actor, "reports.manage", viewRef(view))).allowed;

/**
 * Loads a view the caller may read: own, shared with a held role, or managed (`reports.manage` over it). Anything else,
 * other tenants included, is a 404 (existence is not revealed).
 */
export async function loadReadableView(tx: TenantTx, actor: Actor, viewId: string, now: Date = new Date()): Promise<{ row: ViewRow; manages: boolean }> {
  const row = await tx.savedReportView.findFirst({ where: { id: viewId, tenantId: actor.tenantId }, include: viewInclude });
  if (!row) throw new NotFoundError();
  const manages = await managesView(tx, actor, row);
  if (row.ownerId === actor.userId || manages) return { row, manages };
  const held = await heldRoleIds(tx, actor, now);
  if (!row.archivedAt && row.shares.some((share) => held.includes(share.roleId))) return { row, manages };
  throw new NotFoundError();
}

/** The definition stored in a view, as a run takes it. */
export const definitionOf = (row: Pick<SavedReportView, "datasetKey" | "columns" | "filters" | "scopeOrgUnitId">): ReportDefinition => ({
  datasetKey: row.datasetKey,
  columns: row.columns,
  filters: (row.filters ?? {}) as Record<string, unknown>,
  scopeOrgUnitId: row.scopeOrgUnitId,
});

/**
 * A definition about to be saved must be valid for the dataset and fully visible to the person saving it.
 * @throws ValidationError / ForbiddenError (from `prepareReport`, plus hidden columns named here)
 */
async function assertSavable(tx: TenantTx, actor: Actor, definition: ReportDefinition): Promise<void> {
  const prepared = await prepareReport(tx, actor, definition);
  if (prepared.hiddenColumns.length > 0) {
    throw new ForbiddenError({ message: `You cannot see these columns: ${prepared.hiddenColumns.join(", ")}.` });
  }
}

/** `GET /reports/views`: own views, views shared with a held role and views the caller manages; newest first. */
export async function listViews(actor: Actor, query: ListViewsQuery): Promise<Page<SavedViewView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "reports.view");
    const now = new Date();
    const held = await heldRoleIds(tx, actor, now);
    const manageScope = await resolveScope(tx, actor, "reports.manage", now);
    const readable: Prisma.SavedReportViewWhereInput[] = [{ ownerId: actor.userId }, { archivedAt: null, shares: { some: { roleId: { in: held } } } }];
    if (manageScope.parts.length > 0) {
      readable.push(buildScopeWhere<Prisma.SavedReportViewWhereInput>(manageScope, { orgUnit: (ids) => ({ scopeOrgUnitId: { in: ids } }) }, now));
    }
    const rows = await tx.savedReportView.findMany({
      where: {
        AND: [
          { tenantId: actor.tenantId, OR: readable },
          query.includeArchived === "true" ? {} : { archivedAt: null },
          query.datasetKey ? { datasetKey: query.datasetKey } : {},
        ],
      },
      include: viewInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data: SavedViewView[] = [];
    for (const row of page.data) data.push(toView(row, row.ownerId === actor.userId || (await managesView(tx, actor, row))));
    return { data, page: page.page };
  });
}

/** `GET /reports/views/{id}`. */
export async function getView(actor: Actor, viewId: string): Promise<SavedViewView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "reports.view");
    const { row, manages } = await loadReadableView(tx, actor, viewId);
    return toView(row, manages || row.ownerId === actor.userId);
  });
}

/** `POST /reports/views` (`reports.create`). Audited as `report_view.create`. */
export async function createView(actor: Actor, ctx: RequestContext, input: CreateViewInput): Promise<SavedViewView> {
  return conflictOnUniqueViolation(NAME_TAKEN, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "reports.create");
      getDataset(input.datasetKey);
      const definition: ReportDefinition = { datasetKey: input.datasetKey, columns: input.columns, filters: input.filters, scopeOrgUnitId: input.scopeOrgUnitId };
      await assertSavable(tx, actor, definition);
      const row = await tx.savedReportView.create({
        data: {
          tenantId: actor.tenantId,
          ownerId: actor.userId,
          name: input.name,
          datasetKey: input.datasetKey,
          columns: input.columns,
          filters: input.filters as Prisma.InputJsonValue,
          scopeOrgUnitId: input.scopeOrgUnitId,
        },
        include: viewInclude,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "report_view.create",
        targetType: "SavedReportView",
        targetId: row.id,
        newValue: { name: row.name, datasetKey: row.datasetKey, columns: row.columns, filters: row.filters, scopeOrgUnitId: row.scopeOrgUnitId },
      });
      return toView(row, true);
    }),
  );
}

/** Loads the caller's OWN active view for a change. @throws NotFoundError / ForbiddenError / InvalidStateTransitionError */
async function loadOwnActiveView(tx: TenantTx, actor: Actor, viewId: string): Promise<ViewRow> {
  const { row } = await loadReadableView(tx, actor, viewId);
  if (row.ownerId !== actor.userId) throw new ForbiddenError({ message: "Only the owner can change a saved view." });
  if (row.archivedAt) throw new InvalidStateTransitionError({ message: "The view is archived." });
  return row;
}

/** `PATCH /reports/views/{id}`: name, columns, filters, org unit of the caller's own active view (`reports.create`). */
export async function updateView(actor: Actor, ctx: RequestContext, viewId: string, input: UpdateViewInput): Promise<SavedViewView> {
  return conflictOnUniqueViolation(NAME_TAKEN, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "reports.create");
      const current = await loadOwnActiveView(tx, actor, viewId);
      const next = {
        name: input.name ?? current.name,
        columns: input.columns ?? current.columns,
        filters: (input.filters ?? current.filters) as Record<string, unknown>,
        scopeOrgUnitId: input.scopeOrgUnitId === undefined ? current.scopeOrgUnitId : input.scopeOrgUnitId,
      };
      await assertSavable(tx, actor, { datasetKey: current.datasetKey, ...next });
      const row = await tx.savedReportView.update({
        where: { id: current.id },
        data: { name: next.name, columns: next.columns, filters: next.filters as Prisma.InputJsonValue, scopeOrgUnitId: next.scopeOrgUnitId },
        include: viewInclude,
      });
      const before = { name: current.name, columns: current.columns, filters: current.filters, scopeOrgUnitId: current.scopeOrgUnitId };
      const after = { name: row.name, columns: row.columns, filters: row.filters, scopeOrgUnitId: row.scopeOrgUnitId };
      const { previous, next: changed } = changedFields(before, after);
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "report_view.update",
        targetType: "SavedReportView",
        targetId: row.id,
        previousValue: previous,
        newValue: changed,
      });
      return toView(row, true);
    }),
  );
}

/** `POST /reports/views/{id}/archive`: the owner (`reports.create`) or a `reports.manage` holder over the view. */
export async function archiveView(actor: Actor, ctx: RequestContext, viewId: string): Promise<SavedViewView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "reports.view");
    const { row: current, manages } = await loadReadableView(tx, actor, viewId);
    const ownsIt = current.ownerId === actor.userId && (await canInTx(tx, actor, "reports.create")).allowed;
    if (!ownsIt && !manages) throw new ForbiddenError({ message: "Only the owner or a report manager can archive this view." });
    if (current.archivedAt) throw new InvalidStateTransitionError({ message: "The view is already archived." });
    const row = await tx.savedReportView.update({
      where: { id: current.id },
      data: { archivedAt: new Date(), archivedById: actor.userId },
      include: viewInclude,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "report_view.archive",
      targetType: "SavedReportView",
      targetId: row.id,
      newValue: { archivedAt: row.archivedAt, ownerId: row.ownerId },
    });
    return toView(row, true);
  });
}

/**
 * `POST /reports/views/{id}/shares` (`reports.manage` over the view): shares an active view with a role that already
 * holds the dataset's view permission, so a share never hands a role a dataset it could not open. Audited.
 */
export async function shareView(actor: Actor, ctx: RequestContext, viewId: string, roleId: string): Promise<SavedViewView> {
  return conflictOnUniqueViolation("The view is already shared with this role.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "reports.manage");
      const { row } = await loadReadableView(tx, actor, viewId);
      await enforceInTx(tx, actor, "reports.manage", viewRef(row));
      if (row.archivedAt) throw new InvalidStateTransitionError({ message: "An archived view cannot be shared." });
      const dataset = getDataset(row.datasetKey);
      const role = await tx.role.findFirst({
        where: { id: roleId, tenantId: actor.tenantId, active: true },
        select: { id: true, permissions: { where: { permission: { key: dataset.viewPermission } }, select: { permissionId: true } } },
      });
      if (!role) throw new ValidationError({ message: "The role does not exist or is archived.", field: "roleId" });
      if (role.permissions.length === 0) {
        throw new ValidationError({ message: `The role does not hold ${dataset.viewPermission}, which this dataset needs.`, field: "roleId" });
      }
      if (row.shares.some((share) => share.roleId === roleId)) throw new ConflictError({ message: "The view is already shared with this role." });
      await tx.savedReportViewShare.create({ data: { tenantId: actor.tenantId, viewId: row.id, roleId, sharedById: actor.userId } });
      await recordAudit(tx, { ...auditContextFields(ctx), action: "report_view.share", targetType: "SavedReportView", targetId: row.id, newValue: { roleId } });
      const updated = await tx.savedReportView.findFirstOrThrow({ where: { id: row.id }, include: viewInclude });
      return toView(updated, true);
    }),
  );
}

/** `DELETE /reports/views/{id}/shares/{roleId}` (`reports.manage` over the view): removes the share row, audited. */
export async function unshareView(actor: Actor, ctx: RequestContext, viewId: string, roleId: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "reports.manage");
    const { row } = await loadReadableView(tx, actor, viewId);
    await enforceInTx(tx, actor, "reports.manage", viewRef(row));
    const removed = await tx.savedReportViewShare.deleteMany({ where: { tenantId: actor.tenantId, viewId: row.id, roleId } });
    if (removed.count === 0) throw new NotFoundError();
    await recordAudit(tx, { ...auditContextFields(ctx), action: "report_view.unshare", targetType: "SavedReportView", targetId: row.id, previousValue: { roleId } });
  });
}
