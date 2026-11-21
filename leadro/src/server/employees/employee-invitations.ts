import { createInvitation, type ClientInfo } from "@/server/auth";
import { enforceInTx } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import type { InviteEmployeeInput } from "./schemas";

/**
 * Invites an employee to create a LEADRO login (§22.1). Account creation is invitation-only: the
 * invitation links to the employee record, the invitee sets their own password, and the optional
 * role is granted when they accept, always with an explicit data scope.
 *
 * Authority (nothing here widens what the inviter already has):
 *  - `users.create` over the employee (their placement must be inside the inviter's scope);
 *  - with a role: the inviter must be able to `assignRole` that role over that scope to this person.
 *    Auth runs that anti-escalation check now (dry run) and again when the invitation is accepted.
 *
 * The single-use token goes to the configured notifier (email/SMS), never back to the caller, so an
 * administrator cannot use an invitation to take over the account they invited.
 *
 * @throws ConflictError when the employee already has a login or the email belongs to an active
 *   account, ValidationError without any usable email, InvalidStateTransitionError for a terminated employee.
 */
export async function inviteEmployee(
  actor: Actor,
  employeeId: string,
  input: InviteEmployeeInput,
  client: ClientInfo,
): Promise<{ invitationId: string; expiresAt: Date }> {
  const email = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "users.create", { employeeId });
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, tenantId: actor.tenantId },
      select: { email: true, userId: true, status: true },
    });
    if (!employee) throw new NotFoundError();
    if (employee.status === "TERMINATED") {
      throw new InvalidStateTransitionError({ message: "A terminated employee cannot be invited." });
    }
    if (employee.userId) throw new ConflictError({ message: "This employee already has a login." });

    const address = input.email ?? employee.email;
    if (!address) {
      throw new ValidationError({ message: "The employee has no email address; provide one to invite them.", field: "email" });
    }
    const existing = await tx.user.findUnique({
      where: { tenantId_email: { tenantId: actor.tenantId, email: address } },
      select: { status: true, employee: { select: { id: true } } },
    });
    // An INVITED account may be re-invited (the newest link wins); anything else, or an account
    // already tied to a different employee, must not be touched by an invitation.
    if (existing && (existing.status !== "INVITED" || (existing.employee && existing.employee.id !== employeeId))) {
      throw new ConflictError({ message: "An account with this email already exists.", field: "email" });
    }
    return address;
  });

  const invitation = await createInvitation(
    actor.tenantId,
    { email, invitedById: actor.userId, employeeId, roleId: input.roleId, scope: input.scope },
    client,
  );
  return { invitationId: invitation.invitationId, expiresAt: invitation.expiresAt };
}
