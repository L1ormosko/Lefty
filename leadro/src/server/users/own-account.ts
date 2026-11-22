import { recordAudit } from "@/server/audit";
import type { ClientInfo } from "@/server/auth";
import { NotFoundError, type Actor } from "@/server/core";
import { prisma, withTenant } from "@/server/db";

/**
 * Self-service reads and writes on the caller's OWN account. A user may always see and change
 * these about themselves, so no permission check applies (same rule as `getOwnProfile` and
 * `auth.listOwnSessions`); every query is pinned to `actor.userId`, never to an id from input.
 */

export interface OwnAccountSummary {
  /** Employee name when the user has an employee record, else the email address. */
  displayName: string;
  email: string;
  tenantName: string;
  /** Whether a working authenticator exists (decides the enroll vs. verify screens). */
  mfaEnabled: boolean;
}

/** What the app shell header, user menu and the MFA / security pages need to know about the caller. */
export async function getOwnAccountSummary(actor: Actor): Promise<OwnAccountSummary> {
  const [tenant, user] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } }),
    withTenant(actor.tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId },
        select: { email: true, mfaEnabled: true, employee: { select: { firstName: true, lastName: true } } },
      }),
    ),
  ]);
  if (!tenant || !user) throw new NotFoundError();
  const employeeName = user.employee ? `${user.employee.firstName} ${user.employee.lastName}`.trim() : "";
  return { displayName: employeeName || user.email, email: user.email, tenantName: tenant.name, mfaEnabled: user.mfaEnabled };
}

/**
 * Changes the caller's own interface language (`null` clears it, so the branch/company default applies).
 * Audited as `user.locale_change` in the same transaction; a no-op change writes nothing.
 * @returns true when the stored value changed.
 */
export async function updateOwnLocale(actor: Actor, client: ClientInfo, locale: string | null): Promise<boolean> {
  return withTenant(actor.tenantId, async (tx) => {
    const current = await tx.user.findFirst({ where: { id: actor.userId, tenantId: actor.tenantId }, select: { locale: true } });
    if (!current) throw new NotFoundError();
    if (current.locale === locale) return false;
    await tx.user.update({ where: { id: actor.userId }, data: { locale } });
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "user.locale_change",
      targetType: "User",
      targetId: actor.userId,
      previousValue: { locale: current.locale },
      newValue: { locale },
      sourceApp: client.sourceApp,
      correlationId: client.correlationId,
      ipAddress: client.ipAddress,
    });
    return true;
  });
}
