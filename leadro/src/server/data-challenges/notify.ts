import type { DataChallenge } from "@prisma/client";
import { activePlacementWhere } from "@/server/authz";
import type { TenantTx } from "@/server/db";
import { notifyInTx, registerNotificationTargetResolver, resolveRecipientsByPermission } from "@/server/notifications";

/**
 * Data challenge notifications (§14): written inside the business transaction with `notifyInTx`; the service hands the
 * returned ids to `deliverAfterCommit` once it committed. Links to a challenge are re-authorized at read time with the
 * recipient's CURRENT `data_challenges.view` over the challenge's employee.
 */

const VIEW = "data_challenges.view";

/** Read-time access for notifications that link to a challenge. Called at load and from `src/server/notification-targets.ts`; idempotent. */
export function registerDataChallengeNotificationTarget(): void {
  registerNotificationTargetResolver("data_challenge", VIEW, async (tx, subject, challengeId) => {
    const challenge = await tx.dataChallenge.findFirst({ where: { id: challengeId, tenantId: subject.tenantId }, select: { employeeId: true } });
    return challenge ? { employeeId: challenge.employeeId } : null;
  });
}
registerDataChallengeNotificationTarget();

const target = (challenge: DataChallenge) => ({
  targetType: "data_challenge",
  targetId: challenge.id,
  permission: VIEW,
  resource: { employeeId: challenge.employeeId },
});

/**
 * A new challenge: everyone who may route it (`data_challenges.assign`) over one of the employee's current units, except
 * the employee. Tenant-wide routers (HR, the Owner) match any unit. An employee without a current placement notifies nobody;
 * the challenge still appears in the routers' OPEN list.
 */
export async function notifyChallengeRaised(tx: TenantTx, challenge: DataChallenge): Promise<string[]> {
  const placements = await tx.organizationalAssignment.findMany({
    where: { tenantId: challenge.tenantId, employeeId: challenge.employeeId, ...activePlacementWhere(new Date()) },
    select: { orgUnitId: true },
  });
  const recipients = new Set<string>();
  for (const unit of new Set(placements.map((placement) => placement.orgUnitId))) {
    const users = await resolveRecipientsByPermission(tx, challenge.tenantId, {
      permissions: ["data_challenges.assign"],
      orgUnitId: unit,
      excludeUserIds: [challenge.raisedById],
    });
    for (const userId of users) recipients.add(userId);
  }
  if (recipients.size === 0) return [];
  // notifyInTx drops anyone who may not view the challenge itself (scope over the employee).
  const result = await notifyInTx(tx, {
    tenantId: challenge.tenantId,
    eventType: "data_challenge.raised",
    eventId: `${challenge.id}:raised`,
    recipientUserIds: [...recipients],
    target: target(challenge),
  });
  return result.createdNotificationIds;
}

/** The reviewer of an (re)assignment, unless they assigned it to themselves. One notification per assignment time. */
export async function notifyReviewerAssigned(tx: TenantTx, challenge: DataChallenge, actorUserId: string): Promise<string[]> {
  if (!challenge.reviewerId || !challenge.assignedAt || challenge.reviewerId === actorUserId) return [];
  const result = await notifyInTx(tx, {
    tenantId: challenge.tenantId,
    eventType: "data_challenge.assigned",
    eventId: `${challenge.id}:assigned:${challenge.assignedAt.getTime()}`,
    recipientUserIds: [challenge.reviewerId],
    target: target(challenge),
  });
  return result.createdNotificationIds;
}

/** The employee who raised it: their challenge was upheld or rejected (no link, no text: they read it through self-service). */
export async function notifyEmployeeDecided(tx: TenantTx, challenge: DataChallenge): Promise<string[]> {
  const result = await notifyInTx(tx, {
    tenantId: challenge.tenantId,
    eventType: "data_challenge.decided",
    eventId: `${challenge.id}:decided`,
    recipientUserIds: [challenge.raisedById],
  });
  return result.createdNotificationIds;
}
