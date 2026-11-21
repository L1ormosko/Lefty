import type { AuthEventType } from "@prisma/client";
import { recordAudit, type AuditOutcome } from "@/server/audit";
import type { TenantTx } from "@/server/db";
import type { ClientInfo } from "./client-info";

/** Every auth event is also an audit event (§21); this maps the login-history type to the audit action. */
const AUDIT_BY_EVENT_TYPE: Record<AuthEventType, { action: string; outcome: AuditOutcome }> = {
  LOGIN_SUCCEEDED: { action: "auth.login", outcome: "SUCCESS" },
  LOGIN_FAILED: { action: "auth.login", outcome: "FAILED" },
  LOGOUT: { action: "auth.logout", outcome: "SUCCESS" },
  SESSION_REVOKED: { action: "auth.session_revoke", outcome: "SUCCESS" },
  ACCOUNT_LOCKED: { action: "auth.account_lock", outcome: "DENIED" },
  ACCOUNT_UNLOCKED: { action: "auth.account_unlock", outcome: "SUCCESS" },
  PASSWORD_RESET_REQUESTED: { action: "auth.password_reset_request", outcome: "SUCCESS" },
  PASSWORD_RESET_COMPLETED: { action: "auth.password_reset_complete", outcome: "SUCCESS" },
  PASSWORD_CHANGED: { action: "auth.password_change", outcome: "SUCCESS" },
  INVITATION_ACCEPTED: { action: "auth.invitation_accept", outcome: "SUCCESS" },
  MFA_CHALLENGE_SUCCEEDED: { action: "auth.mfa_challenge", outcome: "SUCCESS" },
  MFA_CHALLENGE_FAILED: { action: "auth.mfa_challenge", outcome: "FAILED" },
};

export interface AuthEventInput {
  tenantId: string;
  /** Null when the attempt did not match any account. */
  userId: string | null;
  type: AuthEventType;
  client: ClientInfo;
  /** What the caller typed; recorded for failed logins only, to spot targeted attacks. */
  emailAttempted?: string;
  /** Why (e.g. `{ reason: "bad_password" }`). Never put secrets here. */
  metadata?: Record<string, unknown>;
}

/**
 * Writes the login-history row (AuthenticationEvent) and the matching audit event in the caller's
 * transaction. The reason for a failure is stored for administrators but never returned to the
 * client, which only ever sees a generic error (no account enumeration).
 */
export async function recordAuthEvent(tx: TenantTx, event: AuthEventInput): Promise<void> {
  await tx.authenticationEvent.create({
    data: {
      tenantId: event.tenantId,
      userId: event.userId,
      emailAttempted: event.emailAttempted,
      type: event.type,
      ipAddress: event.client.ipAddress,
      userAgent: event.client.userAgent,
      correlationId: event.client.correlationId,
      metadata: event.metadata as object | undefined,
    },
  });
  const audit = AUDIT_BY_EVENT_TYPE[event.type];
  await recordAudit(tx, {
    tenantId: event.tenantId,
    actorUserId: event.userId,
    action: audit.action,
    targetType: "User",
    targetId: event.userId ?? undefined,
    newValue: { ...event.metadata, emailAttempted: event.emailAttempted },
    outcome: audit.outcome,
    sourceApp: event.client.sourceApp,
    correlationId: event.client.correlationId,
    ipAddress: event.client.ipAddress,
  });
}
