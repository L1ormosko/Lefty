import type { ScopeType } from "@prisma/client";
import type { TenantTx } from "@/server/db";
import { parseConditions, type GrantConditions } from "./conditions";
import type { AccessSubject } from "./types";

export type GrantStatus = "ACTIVE" | "REVOKED" | "EXPIRED" | "NOT_YET_EFFECTIVE" | "ROLE_INACTIVE";

export interface LoadedScope {
  id: string;
  type: ScopeType;
  legalEntityId: string | null;
  orgUnitId: string | null;
  includeDescendants: boolean;
}

/** One role assignment of the subject whose role holds the permission being checked. */
export interface LoadedGrant {
  roleAssignmentId: string;
  roleId: string;
  roleName: string;
  requiresMfa: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: GrantStatus;
  /** `null` = malformed conditions: the grant is unusable (see conditions.ts). */
  conditions: GrantConditions | null;
  scopes: LoadedScope[];
}

/** What the database says about the subject right now. */
export interface SubjectState {
  isActive: boolean;
  /** From the DB, not from the session: a stale `actor.employeeId` must not widen OWN scope. */
  employeeId: string | null;
}

/**
 * Reads the subject's account state. A user who is not ACTIVE (invited, locked, deactivated) or
 * whose employee record is TERMINATED has no access at all, whatever roles they still hold
 * (spec 25.5 "User is terminated").
 */
export async function loadSubjectState(tx: TenantTx, subject: AccessSubject): Promise<SubjectState> {
  const user = await tx.user.findFirst({
    where: { id: subject.userId, tenantId: subject.tenantId },
    select: { status: true, employee: { select: { id: true, status: true } } },
  });
  if (!user) return { isActive: false, employeeId: null };
  const isActive = user.status === "ACTIVE" && user.employee?.status !== "TERMINATED";
  return { isActive, employeeId: user.employee?.id ?? null };
}

function classify(
  row: { revokedAt: Date | null; effectiveFrom: Date; effectiveTo: Date | null; role: { active: boolean } },
  now: Date,
): GrantStatus {
  if (row.revokedAt !== null) return "REVOKED";
  if (row.effectiveFrom > now) return "NOT_YET_EFFECTIVE";
  if (row.effectiveTo !== null && row.effectiveTo <= now) return "EXPIRED";
  if (!row.role.active) return "ROLE_INACTIVE";
  return "ACTIVE";
}

/**
 * Loads every role assignment of the subject whose role grants `permissionKey`, with a status
 * computed against `now`. Callers use only `ACTIVE` grants for decisions; the rest exist so the
 * "why" diagnostic can explain an expired or revoked grant. Always a fresh read (no caching).
 */
export async function loadGrants(
  tx: TenantTx,
  subject: AccessSubject,
  permissionKey: string,
  now: Date,
): Promise<LoadedGrant[]> {
  const rows = await tx.roleAssignment.findMany({
    where: {
      tenantId: subject.tenantId,
      userId: subject.userId,
      role: { permissions: { some: { permission: { key: permissionKey } } } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      roleId: true,
      effectiveFrom: true,
      effectiveTo: true,
      revokedAt: true,
      scopes: {
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true },
      },
      role: {
        select: {
          name: true,
          active: true,
          requiresMfa: true,
          permissions: { where: { permission: { key: permissionKey } }, select: { conditions: true }, take: 1 },
        },
      },
    },
  });

  return rows.map((row) => ({
    roleAssignmentId: row.id,
    roleId: row.roleId,
    roleName: row.role.name,
    requiresMfa: row.role.requiresMfa,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    status: classify(row, now),
    conditions: parseConditions(row.role.permissions[0]?.conditions),
    scopes: row.scopes,
  }));
}
