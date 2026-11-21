import { ConflictError, ValidationError } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import { INVITATION_TTL_MS, RATE_LIMITS } from "./config";
import { clientKey, type ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { normaliseEmail } from "./normalise-email";
import { assertPasswordMeetsPolicy, hashPassword } from "./passwords";
import { enforceRateLimit } from "./rate-limiter";
import { hashToken, issueToken, tenantIdFromToken } from "./tokens";

export interface CreateInvitationInput {
  email: string;
  invitedById: string | null;
  /** Role granted when the invitation is accepted (optional). */
  roleId?: string;
  /** Existing employee record to link to the new user (optional). */
  employeeId?: string;
}

export interface CreatedInvitation {
  invitationId: string;
  /** The raw single-use token. Deliver it to the invitee; it is not recoverable afterwards. */
  token: string;
  expiresAt: Date;
}

/**
 * Creates a single-use invitation valid for 72 hours. Earlier open invitations for the same email
 * are revoked so only the newest link works. The caller (user administration) is responsible for
 * checking the inviter's permission and for delivering the token.
 */
export async function createInvitation(
  tenantId: string,
  input: CreateInvitationInput,
  client: ClientInfo,
): Promise<CreatedInvitation> {
  const email = normaliseEmail(input.email);
  const { token, tokenHash } = issueToken(tenantId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

  return withTenant(tenantId, async (tx) => {
    await tx.invitation.updateMany({
      where: { tenantId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    const invitation = await tx.invitation.create({
      data: {
        tenantId,
        email,
        tokenHash,
        expiresAt,
        invitedById: input.invitedById,
        roleId: input.roleId,
        employeeId: input.employeeId,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      tenantId,
      actorUserId: input.invitedById,
      action: "auth.invitation_create",
      targetType: "Invitation",
      targetId: invitation.id,
      newValue: { email, roleId: input.roleId, employeeId: input.employeeId, expiresAt },
      sourceApp: client.sourceApp,
      correlationId: client.correlationId,
      ipAddress: client.ipAddress,
    });
    return { invitationId: invitation.id, token, expiresAt };
  });
}

const INVALID_INVITATION_MESSAGE = "This invitation is invalid or has expired.";

/**
 * Accepts an invitation: sets the user's password and activates the account (creating the user
 * if it does not exist yet, assigning the invited role if one was given). The token is consumed
 * with a conditional UPDATE, so two concurrent accepts cannot both succeed.
 *
 * Unknown, expired, revoked and already-used tokens all give the same error.
 * @returns the id of the activated user. No session is created: the user logs in afterwards.
 */
export async function acceptInvitation(
  input: { token: string; password: string },
  client: ClientInfo,
): Promise<{ userId: string }> {
  enforceRateLimit(`invitation:ip:${clientKey(client)}`, RATE_LIMITS.invitationAcceptPerIp);
  const tenantId = tenantIdFromToken(input.token);
  if (!tenantId) throw new ValidationError({ message: INVALID_INVITATION_MESSAGE });

  const now = new Date();
  return withTenant(tenantId, async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
    if (!invitation || invitation.tenantId !== tenantId) throw new ValidationError({ message: INVALID_INVITATION_MESSAGE });

    assertPasswordMeetsPolicy(input.password, invitation.email);
    const passwordHash = await hashPassword(input.password);

    // Single-use: only the request that flips acceptedAt from null proceeds.
    const consumed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (consumed.count === 0) throw new ValidationError({ message: INVALID_INVITATION_MESSAGE });

    const existing = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email: invitation.email } } });
    if (existing && existing.status !== "INVITED") {
      // An active or deactivated account must not be taken over (or revived) by an invitation.
      throw new ConflictError({ message: INVALID_INVITATION_MESSAGE });
    }
    const credentials = { passwordHash, status: "ACTIVE" as const, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null };
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: credentials, select: { id: true } })
      : await tx.user.create({ data: { tenantId, email: invitation.email, ...credentials }, select: { id: true } });

    if (invitation.employeeId) {
      await tx.employee.updateMany({
        where: { id: invitation.employeeId, tenantId, userId: null },
        data: { userId: user.id },
      });
    }
    if (invitation.roleId) {
      await tx.roleAssignment.create({
        data: {
          tenantId,
          userId: user.id,
          roleId: invitation.roleId,
          grantedById: invitation.invitedById,
          reason: "Granted by invitation",
        },
      });
    }
    await recordAuthEvent(tx, {
      tenantId,
      userId: user.id,
      type: "INVITATION_ACCEPTED",
      client,
      metadata: { invitationId: invitation.id },
    });
    return { userId: user.id };
  });
}
