import { cache } from "react";
import { prisma, withTenant } from "@/server/db";
import type { Actor } from "@/server/core";

export interface ShellIdentity {
  /** Employee name when the user has an employee record, else the email address. */
  displayName: string;
  email: string;
  tenantName: string;
}

/**
 * Own-record reads for the shell header and user menu. A user may always read themselves, so no
 * permission check applies (same rule as `listOwnSessions`); the read still runs under RLS.
 */
export const loadShellIdentity = cache(async (actor: Actor): Promise<ShellIdentity> => {
  const [tenant, user] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true } }),
    withTenant(actor.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { email: true, employee: { select: { firstName: true, lastName: true } } },
      }),
    ),
  ]);
  const employeeName = user.employee ? `${user.employee.firstName} ${user.employee.lastName}`.trim() : "";
  return { displayName: employeeName || user.email, email: user.email, tenantName: tenant.name };
});

/** Whether the caller already has a working authenticator (decides enroll vs. verify screens). */
export async function loadMfaEnabled(actor: Actor): Promise<boolean> {
  const user = await withTenant(actor.tenantId, (tx) =>
    tx.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { mfaEnabled: true } }),
  );
  return user.mfaEnabled;
}
