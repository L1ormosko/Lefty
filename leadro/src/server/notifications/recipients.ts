import { activeAssignmentWhere, canInTx } from "@/server/authz";
import type { TenantTx } from "@/server/db";

export interface RecipientQuery {
  /** Users must hold ANY of these permissions with a scope covering `orgUnitId`. */
  permissions: readonly string[];
  /** The unit the event happened in (e.g. the lead's service area). */
  orgUnitId: string;
  /** Left out of the result, typically the actor who caused the event. */
  excludeUserIds?: readonly string[];
}

/**
 * Users who hold one of `permissions` over `orgUnitId` right now. Candidates are pre-selected in
 * SQL (active user, active unexpired assignment of an active role carrying the permission) and each
 * is then confirmed with the authorization engine's own `canInTx`, so scope rules (descendants,
 * archived units, time windows, conditions) have ONE implementation. A grant qualified by a record
 * set (`{ set: ... }`) does not match a plain unit reference and is therefore not a recipient.
 */
export async function resolveRecipientsByPermission(tx: TenantTx, tenantId: string, query: RecipientQuery): Promise<string[]> {
  const excluded = new Set(query.excludeUserIds ?? []);
  const candidates = await tx.user.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      id: { notIn: [...excluded] },
      roleAssignments: {
        some: {
          ...activeAssignmentWhere(new Date()),
          role: { active: true, permissions: { some: { permission: { key: { in: [...query.permissions] } } } } },
        },
      },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const recipients: string[] = [];
  for (const candidate of candidates) {
    for (const permission of query.permissions) {
      const decision = await canInTx(tx, { tenantId, userId: candidate.id }, permission, { orgUnitId: query.orgUnitId });
      if (decision.allowed) {
        recipients.push(candidate.id);
        break;
      }
    }
  }
  return recipients;
}

/**
 * "Lead Operations scope for org unit X" (§14.2): who must hear that a lead in this unit needs an
 * owner. First choice is everyone who may ASSIGN leads over the unit (`leads.assign`); only when
 * nobody can, the audience widens to those who may VIEW leads there (`leads.view`), so a lead never
 * waits in a unit nobody is told about. Returns user ids, ready for `notifyInTx`.
 */
export async function resolveLeadOperationsRecipients(
  tx: TenantTx,
  tenantId: string,
  orgUnitId: string,
  options: { excludeUserIds?: readonly string[] } = {},
): Promise<string[]> {
  const assigners = await resolveRecipientsByPermission(tx, tenantId, { permissions: ["leads.assign"], orgUnitId, ...options });
  if (assigners.length > 0) return assigners;
  return resolveRecipientsByPermission(tx, tenantId, { permissions: ["leads.view"], orgUnitId, ...options });
}
