import type { Invitation } from "@prisma/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { withTenant, type TenantTx } from "@/server/db";
import { INVITATION_TTL_MS, RATE_LIMITS } from "./config";
import { enforceIpRateLimit, type ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import {
  assertInvitationScopeIsValid,
  assertInviterMayGrant,
  createInvitedRoleAssignment,
  type InvitationScope,
} from "./invited-role-assignment";
import { getAuthNotifier } from "./notifier";
import { normaliseEmail } from "./normalise-email";
import { assertPasswordMeetsPolicy, hashPassword } from "./passwords";
import { hashToken, issueToken, tenantIdFromToken } from "./tokens";

export type { InvitationScope } from "./invited-role-assignment";

export interface CreateInvitationInput {
  email: string;
  invitedById: string | null;
  /** Role granted when the invitation is accepted (optional). Requires `scope`. */
  roleId?: string;
  /** Data scope for `roleId`; mandatory with a role, rejected without one. */
  scope?: InvitationScope;
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
 * are revoked so only the newest link works. The token is handed to the configured `AuthNotifier`
 * (email/SMS) after the invitation is committed; callers should not expose it to anyone else.
 *
 * With an inviter and a role, the inviter must be allowed to grant that role over that scope to
 * that person (the same anti-escalation rules as `assignRole`, checked as a dry run), so an
 * invitation can never carry more authority than its issuer holds. The caller (user
 * administration) still checks that the inviter may invite at all (`users.create`).
 *
 * Everything the invitation points at (inviter, role, employee, scope targets) is checked to exist
 * in the tenant, so mistakes surface as validation errors rather than database errors.
 *
 * @throws ValidationError for unknown ids, a role without a scope, or a scope without a role;
 *   ForbiddenError when the inviter may not grant the role.
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
  const invalid = (field: string, message: string) => new ValidationError({ field, message });

  if (input.roleId && !input.scope) throw invalid("scope", "A role can only be granted together with a data scope.");
  if (input.scope && !input.roleId) throw invalid("roleId", "A scope needs a role.");

  const created = await withTenant(tenantId, async (tx) => {
    if (input.invitedById) {
      const inviter = await tx.user.findFirst({ where: { id: input.invitedById, tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!inviter) throw invalid("invitedById", "The inviting user does not exist or is not active.");
    }
    if (input.roleId) {
      const role = await tx.role.findFirst({ where: { id: input.roleId, tenantId, active: true }, select: { id: true } });
      if (!role) throw invalid("roleId", "The role does not exist.");
    }
    if (input.scope) await assertInvitationScopeIsValid(tx, tenantId, input.scope);
    if (input.invitedById && input.roleId && input.scope) {
      await assertInviterMayGrant(tx, {
        tenantId,
        inviterId: input.invitedById,
        roleId: input.roleId,
        scope: input.scope,
        email,
        employeeId: input.employeeId,
      });
    }
    if (input.employeeId) {
      const employee = await tx.employee.findFirst({ where: { id: input.employeeId, tenantId }, select: { id: true } });
      if (!employee) throw invalid("employeeId", "The employee does not exist.");
    }

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
        scopeType: input.scope?.type,
        scopeLegalEntityId: input.scope?.legalEntityId,
        scopeOrgUnitId: input.scope?.orgUnitId,
        scopeIncludeDescendants: input.scope?.includeDescendants ?? true,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      tenantId,
      actorUserId: input.invitedById,
      action: "auth.invitation_create",
      targetType: "Invitation",
      targetId: invitation.id,
      newValue: { email, roleId: input.roleId, scope: input.scope, employeeId: input.employeeId, expiresAt },
      sourceApp: client.sourceApp,
      correlationId: client.correlationId,
      ipAddress: client.ipAddress,
    });
    return { invitationId: invitation.id, token, expiresAt };
  });
  await getAuthNotifier().sendInvitation({ tenantId, email, token: created.token, expiresAt: created.expiresAt });
  return created;
}

const INVALID_INVITATION_MESSAGE = "This invitation is invalid or has expired.";
const invalidInvitation = (): ValidationError => new ValidationError({ message: INVALID_INVITATION_MESSAGE });

/**
 * Is this invitation still usable right now? Checked before bcrypt (to reject dead links cheaply)
 * and again inside the write transaction (state may change in between). Besides expiry/use, the
 * inviter must still be active and the role must still exist: an invitation must not outlive the
 * authority of the person who issued it.
 */
async function assertInvitationIsUsable(tx: TenantTx, invitation: Invitation, now: Date): Promise<void> {
  if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) throw invalidInvitation();
  if (invitation.invitedById) {
    const inviter = await tx.user.findFirst({
      where: { id: invitation.invitedById, tenantId: invitation.tenantId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!inviter) throw invalidInvitation();
  }
  if (invitation.roleId) {
    const role = await tx.role.findFirst({
      where: { id: invitation.roleId, tenantId: invitation.tenantId, active: true },
      select: { id: true },
    });
    if (!role || !invitation.scopeType) throw invalidInvitation();
  }
}

/**
 * Accepts an invitation: sets the user's password and activates the account (creating the user
 * if it does not exist yet, assigning the invited role with its scope if one was given). The token
 * is consumed with a conditional UPDATE, so two concurrent accepts cannot both succeed.
 *
 * Steps: (1) short read + validity check, (2) bcrypt outside any transaction, (3) short write
 * transaction that re-checks validity and consumes the token.
 *
 * Unknown, expired, revoked and already-used tokens all give the same error.
 * @returns the id of the activated user. No session is created: the user logs in afterwards.
 */
export async function acceptInvitation(
  input: { token: string; password: string },
  client: ClientInfo,
): Promise<{ userId: string }> {
  enforceIpRateLimit(client, "invitation:ip", RATE_LIMITS.invitationAcceptPerIp);
  const tenantId = tenantIdFromToken(input.token);
  if (!tenantId) throw invalidInvitation();
  const tokenHash = hashToken(input.token);

  const invitation = await withTenant(tenantId, async (tx) => {
    const found = await tx.invitation.findUnique({ where: { tokenHash } });
    if (!found || found.tenantId !== tenantId) throw invalidInvitation();
    await assertInvitationIsUsable(tx, found, new Date());
    return found;
  });

  assertPasswordMeetsPolicy(input.password, invitation.email);
  const passwordHash = await hashPassword(input.password);

  return withTenant(tenantId, async (tx) => {
    const now = new Date();
    await assertInvitationIsUsable(tx, invitation, now);
    // Single-use: only the request that flips acceptedAt from null proceeds.
    const consumed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (consumed.count === 0) throw invalidInvitation();

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
    if (invitation.roleId && invitation.scopeType) {
      try {
        await createInvitedRoleAssignment(tx, {
          tenantId,
          userId: user.id,
          roleId: invitation.roleId,
          grantedById: invitation.invitedById,
          scope: {
            type: invitation.scopeType,
            legalEntityId: invitation.scopeLegalEntityId ?? undefined,
            orgUnitId: invitation.scopeOrgUnitId ?? undefined,
            includeDescendants: invitation.scopeIncludeDescendants,
          },
        });
      } catch (error) {
        // The inviter lost the authority to grant this (permission removed, moved out of scope,
        // target unit archived...). Do not explain why to the invitee: same answer as a dead link.
        // Throwing rolls the transaction back, so the token is not consumed either.
        if (error instanceof ForbiddenError || error instanceof NotFoundError || error instanceof ValidationError) {
          throw invalidInvitation();
        }
        throw error;
      }
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
