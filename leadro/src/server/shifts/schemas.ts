import { z } from "zod";
import { pageQuerySchema } from "@/server/core";
import { fieldEventEnvelope, locationExceptionSchema, positionSchema } from "@/server/location";

/** Zod schemas of the shifts API. Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

/**
 * Start or end of the caller's own shift. A position (with accuracy and device clock) OR a reason why there is none
 * (GPS off, permission denied, offline ...); both are allowed (a delayed capture). `occurredAt` / `clientEventId` make
 * it offline-safe (spec 8.7).
 */
const boundary = z
  .object({
    ...fieldEventEnvelope,
    position: positionSchema.optional(),
    exception: locationExceptionSchema.optional(),
  })
  .strict();

export const startShiftSchema = boundary;
export type StartShiftInput = z.infer<typeof startShiftSchema>;

/**
 * End a shift. The technician ends their own (no `reason` needed); a manager ending or correcting someone else's shift
 * (`shifts.edit`) must say why (`reason`), and sends no position: the entry is recorded as a manager's, not the device's.
 */
export const endShiftSchema = boundary.extend({ reason: z.string().trim().min(1).max(500).optional() });
export type EndShiftInput = z.infer<typeof endShiftSchema>;

export const shiftIdParams = z.object({ id });

/** A manager's decision on a shift started or ended under an exception. The note is mandatory (DB CHECK `shift_exception_review`). */
export const reviewShiftSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().trim().min(1).max(500) }).strict();
export type ReviewShiftInput = z.infer<typeof reviewShiftSchema>;

export const listShiftsQuerySchema = pageQuerySchema.extend({
  employeeId: id.optional(),
  orgUnitId: id.optional(),
  status: z.enum(["ACTIVE", "ENDED"]).optional(),
  /** `true`: only shifts with an exception; or one review state. */
  exceptionReview: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  from: instant.optional(),
  to: instant.optional(),
});
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;
