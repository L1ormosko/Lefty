import { assessCapture, type CaptureAssessment } from "@/lib/shift-rules";
import { assertBelievableEventTime } from "@/server/field-events";
import { ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { LocationExceptionInput, PositionInput } from "@/server/location";

/** Pieces shared by starting and ending a shift. */

/**
 * Serialises start / end / correction for ONE employee: the row lock makes two concurrent starts (or a start racing an
 * end) queue up, so the loser sees the winner's shift instead of tripping the one-active-shift unique index.
 */
export async function lockEmployee(tx: TenantTx, tenantId: string, employeeId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE`;
}

/**
 * When the boundary happened: the device's `occurredAt` (offline events) or now. Refuses futures and ancient events, unless
 * `judgedByGate` (the write carries a `clientEventId`: the shared gate judges the time on first delivery only, so a late replay still answers).
 */
export function boundaryTime(occurredAt: Date | undefined, now: Date, judgedByGate = false): Date {
  const at = occurredAt ?? now;
  if (!judgedByGate) assertBelievableEventTime(at, now);
  return at;
}

/** Judges the position / reason a boundary came with; a blank capture is refused (spec 17.4: say why there is no position). */
export function assessBoundary(input: { position?: PositionInput; exception?: LocationExceptionInput }, maxAccuracyM: number, delayedByMs: number): CaptureAssessment {
  const assessment = assessCapture({ accuracyM: input.position?.accuracyM, exception: input.exception, maxAccuracyM, delayedByMs });
  if (!assessment) {
    throw new ValidationError({ message: "Send the device position, or say why there is none (GPS off, permission denied, offline).", field: "position" });
  }
  return assessment;
}
