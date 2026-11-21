import type { Actor } from "@/server/core";
import { NotFoundError } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { logger } from "@/server/logging";
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "./config";
import type { ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { hashToken, issueToken, tenantIdFromToken } from "./tokens";

export interface CreatedSession {
  sessionId: string;
  /** The raw token for the cookie. Not stored anywhere. */
  token: string;
  expiresAt: Date;
}

/** Creates a session row (only the token hash is stored). Call inside the login transaction. */
export async function createSession(
  tx: TenantTx,
  params: { tenantId: string; userId: string; mfaPending: boolean; client: ClientInfo },
): Promise<CreatedSession> {
  const { token, tokenHash } = issueToken(params.tenantId);
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS);
  const session = await tx.session.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      tokenHash,
      expiresAt,
      mfaPending: params.mfaPending,
      ipAddress: params.client.ipAddress,
      userAgent: params.client.userAgent,
    },
    select: { id: true },
  });
  return { sessionId: session.id, token, expiresAt };
}

/** Revokes every live session of a user (deactivation, password reset). @returns how many. */
export async function revokeAllSessionsForUser(tx: TenantTx, tenantId: string, userId: string): Promise<number> {
  const result = await tx.session.updateMany({
    where: { tenantId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

type SessionDenialReason = "expired" | "idle_timeout" | "revoked" | "user_inactive" | "tenant_inactive" | "mfa_required";

export interface AuthenticateOptions {
  /** Accept a session that has not completed MFA yet (only the MFA endpoints and logout). */
  allowMfaPending?: boolean;
  client?: ClientInfo;
}

/**
 * Turns a session token into an `Actor`, or null if the token cannot be used. Re-checked on every
 * request (§25.5): the session row, its idle/absolute expiry, the user's status and the tenant's
 * status are all read fresh, so deactivation takes effect immediately.
 *
 * A token that matches a real session but is refused (expired, revoked, deactivated user, MFA not
 * done) is audited as a DENIED access (§21 "failed access"). Tokens that match nothing are only
 * logged: auditing them would let anyone with a garbage cookie fill the audit table.
 *
 * @returns the actor plus whether the session is still waiting for MFA, or null.
 */
export async function resolveSession(
  token: string,
  options: AuthenticateOptions = {},
): Promise<{ actor: Actor; mfaPending: boolean } | null> {
  const tenantId = tenantIdFromToken(token);
  if (!tenantId) return null;
  const now = new Date();

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  if (!tenant) return null;

  const outcome = await withTenant(tenantId, async (tx) => {
    const session = await tx.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { status: true, locale: true, employee: { select: { id: true } } } } },
    });
    if (!session) return { kind: "unknown" as const };

    let denial: SessionDenialReason | null = null;
    if (session.revokedAt) denial = "revoked";
    else if (session.expiresAt <= now) denial = "expired";
    else if (now.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_MS) denial = "idle_timeout";
    else if (tenant.status !== "ACTIVE") denial = "tenant_inactive";
    else if (session.user.status !== "ACTIVE") denial = "user_inactive";
    else if (session.mfaPending && !options.allowMfaPending) denial = "mfa_required";

    if (denial) {
      await recordAudit(tx, {
        tenantId,
        actorUserId: session.userId,
        action: "auth.access_denied",
        targetType: "Session",
        targetId: session.id,
        newValue: { reason: denial },
        outcome: "DENIED",
        sourceApp: options.client?.sourceApp ?? "API",
        correlationId: options.client?.correlationId,
        ipAddress: options.client?.ipAddress,
      });
      return { kind: "denied" as const, reason: denial };
    }

    if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
      await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    const actor: Actor = {
      tenantId,
      userId: session.userId,
      employeeId: session.user.employee?.id ?? null,
      sessionId: session.id,
      locale: session.user.locale,
    };
    return { kind: "ok" as const, actor, mfaPending: session.mfaPending };
  });

  if (outcome.kind === "unknown") {
    logger.warn("session token matched no session", { tenantId });
    return null;
  }
  if (outcome.kind === "denied") {
    logger.info("session refused", { tenantId, reason: outcome.reason });
    return null;
  }
  return { actor: outcome.actor, mfaPending: outcome.mfaPending };
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  /** True for the session making this request. */
  isCurrent: boolean;
}

/** The caller's own live sessions, newest first. Own data only, so no permission check applies. */
export async function listOwnSessions(actor: Actor): Promise<SessionSummary[]> {
  const now = new Date();
  const sessions = await withTenant(actor.tenantId, (tx) =>
    tx.session.findMany({
      where: { tenantId: actor.tenantId, userId: actor.userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, ipAddress: true, userAgent: true },
    }),
  );
  return sessions.map((session) => ({ ...session, isCurrent: session.id === actor.sessionId }));
}

/**
 * Revokes one of the caller's own sessions. Someone else's session id answers NotFound, so ids of
 * other users' sessions are never confirmed.
 */
export async function revokeOwnSession(actor: Actor, sessionId: string, client: ClientInfo): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const result = await tx.session.updateMany({
      where: { id: sessionId, tenantId: actor.tenantId, userId: actor.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundError();
    await recordAuthEvent(tx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      type: "SESSION_REVOKED",
      client,
      metadata: { sessionId },
    });
  });
}
