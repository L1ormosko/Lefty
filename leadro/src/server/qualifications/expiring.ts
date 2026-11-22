import type { Prisma, QualificationKind } from "@prisma/client";
import { addDays, localIsoDate } from "@/lib/zoned-time";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { ExpiringQualificationsQuery } from "./schemas";
import { qualificationScopeColumns } from "./views";

/**
 * "Credentials expiring within N days" (§10.1, §14): the query the notification engine runs to warn
 * employees and their managers, and the HR "expiring soon" list.
 *
 * Only VERIFIED rows count (a pending or revoked row does not grant eligibility, so its date warns
 * of nothing), for employees who are not terminated. The calendar is the company's: "today" is the
 * date in the tenant's default time zone, an expiry date is valid through the end of that day, and a
 * row expiring TODAY is still listed as expiring (0 days left).
 */

const DEFAULT_WARNING_DAYS = 30;

export interface ExpiringQualification {
  qualificationId: string;
  employeeId: string;
  /** The employee's login (the person to notify); null when they have none. */
  userId: string | null;
  kind: QualificationKind;
  skillId: string | null;
  certificationId: string | null;
  /** Catalog name of the skill or credential. */
  name: string;
  /** `YYYY-MM-DD`. */
  expiresOn: string;
  /** 0 = expires today (still valid through today); negative = already expired. */
  daysRemaining: number;
}

/** The tenant's configured warning horizon (`OperationsSettings.qualificationWarningDays`, default 30). */
export async function qualificationWarningDays(tx: TenantTx, tenantId: string): Promise<number> {
  const settings = await tx.operationsSettings.findUnique({ where: { tenantId }, select: { qualificationWarningDays: true } });
  return settings?.qualificationWarningDays ?? DEFAULT_WARNING_DAYS;
}

const DAY_MS = 86_400_000;
const daysBetween = (fromIsoDate: string, to: Date): number => Math.round((to.getTime() - Date.parse(`${fromIsoDate}T00:00:00.000Z`)) / DAY_MS);

interface ExpiringOptions {
  /** Defaults to the tenant's warning days. */
  withinDays?: number;
  /** Also return credentials already past their date (still VERIFIED). */
  includeExpired?: boolean;
  now?: Date;
}

async function rowsExpiring(
  tx: TenantTx,
  tenantId: string,
  options: ExpiringOptions,
  extraWhere: Prisma.EmployeeQualificationWhereInput,
  paging: { take: number; cursor?: { id: string }; skip?: number } | null,
) {
  const now = options.now ?? new Date();
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } });
  const today = localIsoDate(now.getTime(), tenant.defaultTimeZone);
  const withinDays = options.withinDays ?? (await qualificationWarningDays(tx, tenantId));
  const horizon = new Date(`${addDays(today, withinDays)}T00:00:00.000Z`);
  const earliest = options.includeExpired ? undefined : new Date(`${today}T00:00:00.000Z`);

  const rows = await tx.employeeQualification.findMany({
    where: withinScope(extraWhere, {
      tenantId,
      status: "VERIFIED",
      expiresAt: { not: null, lte: horizon, ...(earliest ? { gte: earliest } : {}) },
      employee: { status: { not: "TERMINATED" } },
    }),
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      employeeId: true,
      kind: true,
      skillId: true,
      certificationId: true,
      expiresAt: true,
      employee: { select: { userId: true } },
      skill: { select: { name: true } },
      certification: { select: { name: true } },
    },
    ...(paging ?? {}),
  });
  return { rows, today };
}

type ExpiringRow = Awaited<ReturnType<typeof rowsExpiring>>["rows"][number];

function toExpiring(row: ExpiringRow, today: string): ExpiringQualification {
  const expiresAt = row.expiresAt as Date; // the query filters on `not: null`
  return {
    qualificationId: row.id,
    employeeId: row.employeeId,
    userId: row.employee.userId,
    kind: row.kind,
    skillId: row.skillId,
    certificationId: row.certificationId,
    name: row.skill?.name ?? row.certification?.name ?? "",
    expiresOn: expiresAt.toISOString().slice(0, 10),
    daysRemaining: daysBetween(today, expiresAt),
  };
}

/**
 * System-side query for the notification engine: every tenant-wide match, oldest expiry first, no
 * permission check (a scheduled job has no actor; the notification module decides who is told).
 * Use `qualificationId` + `expiresOn` as the dedupe key so a renewal (a new row) notifies again but a
 * re-run does not.
 */
export async function findExpiringQualifications(tx: TenantTx, tenantId: string, options: ExpiringOptions = {}): Promise<ExpiringQualification[]> {
  const { rows, today } = await rowsExpiring(tx, tenantId, options, {}, null);
  return rows.map((row) => toExpiring(row, today));
}

/** The API variant: only employees in the caller's `qualifications.view` scope, paginated. */
export async function listExpiringQualifications(actor: Actor, query: ExpiringQualificationsQuery): Promise<Page<ExpiringQualification>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "qualifications.view", now), "base");
    const scopeWhere = buildScopeWhere(scope, qualificationScopeColumns, now);
    const { rows, today } = await rowsExpiring(
      tx,
      actor.tenantId,
      { withinDays: query.withinDays, includeExpired: query.includeExpired, now },
      scopeWhere,
      pageArgs(query),
    );
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => toExpiring(row, today)), page: page.page };
  });
}
