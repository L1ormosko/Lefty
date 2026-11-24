import { auditContextFields, recordAudit } from "@/server/audit";
import { assertNotSelfApproval, enforceInTx, projectFields } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";
import { recordLocationEventInTx } from "@/server/location";
import { ARRIVAL_FIELD_MAP, arrivalSelect, arrivalView } from "./fields";
import type { VerifyArrivalInput } from "./schemas";

/**
 * A manager's decision on a technician's arrival (§8.4, §17.4): verify it, or reject it, always with a reason. Needs
 * `location.approve` over the job's unit. An arrival that is still RECORDED or PENDING_MANAGER_REVIEW can be decided,
 * once; nobody decides their own arrival (separation of duties, §21.3). Verifying also records a VERIFICATION location
 * event by the manager (no position: the manager vouches, the device did not measure). Rejecting leaves the job status
 * alone (the lifecycle has no way back from ARRIVED) but blocks "start work" for that technician. Locks the arrival so two managers cannot both decide.
 */
export async function verifyArrival(actor: Actor, ctx: RequestContext, jobId: string, arrivalId: string, input: VerifyArrivalInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "location.approve");
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "location.approve", ref);

    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ArrivalVerification" WHERE id = ${arrivalId} AND "jobId" = ${jobId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError();
    const arrival = await tx.arrivalVerification.findFirstOrThrow({ where: { id: arrivalId, tenantId: actor.tenantId }, select: { ...arrivalSelect, employee: { select: { userId: true } } } });
    assertNotSelfApproval(actor.userId, arrival.employee.userId);
    if (arrival.status === "MANAGER_VERIFIED" || arrival.status === "MANAGER_REJECTED") {
      throw new InvalidStateTransitionError({ message: "This arrival was already decided." });
    }

    const verified = input.decision === "VERIFIED";
    const now = new Date();
    if (verified) {
      await recordLocationEventInTx(
        tx,
        {
          tenantId: actor.tenantId,
          employeeId: arrival.employeeId,
          kind: "VERIFICATION",
          source: "MANAGER",
          jobId,
          shiftId: arrival.shiftId ?? undefined,
          verification: "MANAGER_VERIFIED",
          recordedByUserId: actor.userId,
        },
        now,
      );
    }
    await tx.arrivalVerification.update({
      where: { id: arrivalId },
      data: { status: verified ? "MANAGER_VERIFIED" : "MANAGER_REJECTED", verifiedByUserId: actor.userId, verifiedAt: now, verificationNote: input.note },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "arrival.verify",
      targetType: "ArrivalVerification",
      targetId: arrivalId,
      previousValue: { status: arrival.status },
      newValue: { status: verified ? "MANAGER_VERIFIED" : "MANAGER_REJECTED", jobId },
      reason: input.note,
    });
    const updated = await tx.arrivalVerification.findFirstOrThrow({ where: { id: arrivalId, tenantId: actor.tenantId }, select: arrivalSelect });
    return projectFields(arrivalView(updated), decision, ARRIVAL_FIELD_MAP);
  });
}
