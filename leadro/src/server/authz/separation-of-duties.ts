import { ForbiddenError } from "@/server/core";

/**
 * Separation of duties (§21.3, §25.5): nobody approves or rejects a change they submitted
 * themselves. Call it in every approve/reject service, with the submitter recorded on the subject.
 *
 * A subject without a recorded submitter (system-created) cannot be a self-approval.
 */
export function assertNotSelfApproval(actorId: string, subjectCreatedById: string | null | undefined): void {
  if (subjectCreatedById !== null && subjectCreatedById !== undefined && subjectCreatedById === actorId) {
    throw new ForbiddenError({ message: "You cannot approve or reject your own submission." });
  }
}
