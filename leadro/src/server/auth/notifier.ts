import { logger } from "@/server/logging";

export interface PasswordResetMessage {
  tenantId: string;
  userId: string;
  email: string;
  /** The raw reset token. Only the notifier ever sees it. */
  token: string;
  expiresAt: Date;
}

/**
 * How secrets reach people (email/SMS). No delivery provider exists yet (§28.3: no fake
 * integrations), so the default implementation only logs that a reset was requested, WITHOUT the
 * token. A real provider implements this interface and is installed with `setAuthNotifier`.
 */
export interface AuthNotifier {
  sendPasswordReset(message: PasswordResetMessage): Promise<void>;
}

const unconfiguredNotifier: AuthNotifier = {
  async sendPasswordReset(message) {
    logger.warn("password reset token issued but no notifier is configured; nothing was sent", {
      tenantId: message.tenantId,
      userId: message.userId,
    });
  },
};

let activeNotifier: AuthNotifier = unconfiguredNotifier;

export function setAuthNotifier(notifier: AuthNotifier): void {
  activeNotifier = notifier;
}

/** Restores the log-only default (used by tests). */
export function resetAuthNotifier(): void {
  activeNotifier = unconfiguredNotifier;
}

export function getAuthNotifier(): AuthNotifier {
  return activeNotifier;
}
