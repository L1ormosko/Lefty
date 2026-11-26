import { auditContextFields, recordAudit } from "@/server/audit";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, conflictOnUniqueViolation, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { notifyChallengeRaised } from "./notify";
import { lockChallenge, toDataChallengeView, type DataChallengeView } from "./read";
import type { RaiseDataChallengeInput } from "./schemas";
import { assertChallengeableByEmployee, targetColumns } from "./targets";

/**
 * Self-service side of a challenge (spec 10.4 "employees can challenge inaccurate information", 5.11): the employee raises a
 * challenge of one of THEIR OWN records and may withdraw it while it is open or under review. These need no module
 * permission: the record must be the caller's own (checked against its table, inside the transaction), and only the person
 * who raised a challenge may withdraw it.
 */

/** Raises a challenge (status OPEN) and tells the people who route challenges. One open challenge per record (409). */
export async function raiseDataChallenge(actor: Actor, ctx: RequestContext, input: RaiseDataChallengeInput): Promise<DataChallengeView> {
  const employeeId = actor.employeeId;
  // Only an employee has records to challenge; an account without one (the Owner, say) is refused outright.
  if (!employeeId) throw new ForbiddenError({ message: "Only employees can challenge their own records." });
  const { challenge, notificationIds } = await conflictOnUniqueViolation("This record already has an open challenge.", () =>
    withTenant(actor.tenantId, async (tx) => {
      // The target must be the caller's own and visible to them; anything else is "not found" (no existence leak).
      await assertChallengeableByEmployee(tx, actor.tenantId, employeeId, input.targetType, input.targetId);
      const created = await tx.dataChallenge.create({
        data: {
          tenantId: actor.tenantId,
          employeeId,
          targetType: input.targetType,
          ...targetColumns(input.targetType, input.targetId),
          statement: input.statement,
          raisedById: actor.userId,
        },
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "data_challenge.raise",
        targetType: "DataChallenge",
        targetId: created.id,
        // Ids and codes only: the statement is free text about the employee (spec 22.2).
        newValue: { status: created.status, employeeId, targetType: input.targetType, targetId: input.targetId },
      });
      return { challenge: created, notificationIds: await notifyChallengeRaised(tx, created) };
    }),
  );
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return toDataChallengeView(challenge);
}

/** The raiser withdraws their challenge (OPEN or UNDER_REVIEW -> WITHDRAWN). Anyone else gets 404. */
export async function withdrawDataChallenge(actor: Actor, ctx: RequestContext, challengeId: string): Promise<DataChallengeView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await lockChallenge(tx, actor.tenantId, challengeId);
    if (!before || before.raisedById !== actor.userId) throw new NotFoundError();
    if (before.status !== "OPEN" && before.status !== "UNDER_REVIEW") {
      throw new InvalidStateTransitionError({ message: `A ${before.status.toLowerCase().replace("_", " ")} challenge cannot be withdrawn.` });
    }
    const after = await tx.dataChallenge.update({ where: { id: before.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "data_challenge.withdraw",
      targetType: "DataChallenge",
      targetId: after.id,
      previousValue: { status: before.status },
      newValue: { status: after.status },
    });
    return toDataChallengeView(after);
  });
}
