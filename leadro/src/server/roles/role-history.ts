import { findAuditHistoryInTx, type AuditHistoryRow } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";

/** What one history entry changed, reduced to permission KEYS and role field names (never values or qualifiers). */
export interface RoleChangeSummary {
  permissionsAdded: string[];
  permissionsRemoved: string[];
  /** Permissions kept but whose qualifiers (record sets, field sets) changed. */
  permissionsChanged: string[];
  /** Which of name / description / requiresMfa an edit touched. */
  fieldsChanged: string[];
}

/** One entry of a role's permission history, deliberately narrower than the raw audit row. */
export interface RoleHistoryEntry {
  id: string;
  action: string;
  occurredAt: Date;
  reason: string | null;
  /** The responsible user (employee name, else login email); null for system events. */
  actor: { userId: string; displayName: string } | null;
  changes: RoleChangeSummary;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Permission keys out of either `["a"]` or `[{ permission: "a", conditions }]` (the two shapes audit events use). */
function permissionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.map((entry) => (typeof entry === "string" ? entry : asRecord(entry).permission));
  return keys.filter((key): key is string => typeof key === "string");
}

/**
 * Whitelists a raw audit row into a change summary. Only permission keys and field NAMES survive:
 * role names, descriptions and condition payloads in the audit values are not copied out.
 */
export function summarizeRoleChange(row: Pick<AuditHistoryRow, "action" | "previousValue" | "newValue">): RoleChangeSummary {
  const previous = asRecord(row.previousValue);
  const next = asRecord(row.newValue);
  const summary: RoleChangeSummary = { permissionsAdded: [], permissionsRemoved: [], permissionsChanged: [], fieldsChanged: [] };
  switch (row.action) {
    case "role.create":
    case "role.clone":
      summary.permissionsAdded = permissionKeys(next.permissions);
      break;
    case "role.permissions_change":
      summary.permissionsAdded = permissionKeys(next.added);
      summary.permissionsRemoved = permissionKeys(previous.removed);
      summary.permissionsChanged = permissionKeys(next.changed);
      break;
    case "role.update":
      summary.fieldsChanged = Object.keys(next).filter((key) => ["name", "description", "requiresMfa"].includes(key));
      break;
    default:
      break;
  }
  return summary;
}

/**
 * Permission history of a role: every audit event that targeted it (create, clone, edit, permission
 * changes, archive), newest first, as `RoleHistoryEntry` (no IP address, user agent or raw values).
 * Needs a tenant-wide `permissions.view`; the audit trail is append-only, so history cannot be
 * rewritten. A role of another tenant is a 404.
 */
export async function getRoleHistory(actor: Actor, roleId: string, query: { cursor?: string; limit: number }): Promise<Page<RoleHistoryEntry>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "permissions.view", {});
    const exists = await tx.role.findFirst({ where: { id: roleId, tenantId: actor.tenantId }, select: { id: true } });
    if (!exists) throw new NotFoundError();

    const rows = await findAuditHistoryInTx(tx, { tenantId: actor.tenantId, targetType: "Role", targetIds: [roleId] }, pageArgs(query));
    const page = toPage(rows, query.limit);

    const actorIds = [...new Set(page.data.map((row) => row.actorUserId).filter((id): id is string => id !== null))];
    const users = await tx.user.findMany({
      where: { tenantId: actor.tenantId, id: { in: actorIds } },
      select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } },
    });
    const displayName = new Map(users.map((user) => [user.id, user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email]));

    return {
      data: page.data.map((row) => ({
        id: row.id,
        action: row.action,
        occurredAt: row.occurredAt,
        reason: row.reason,
        actor: row.actorUserId ? { userId: row.actorUserId, displayName: displayName.get(row.actorUserId) ?? row.actorUserId } : null,
        changes: summarizeRoleChange(row),
      })),
      page: page.page,
    };
  });
}
