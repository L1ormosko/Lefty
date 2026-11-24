import { z } from "zod";
import { fieldEventEnvelope, locationExceptionSchema, positionSchema } from "@/server/location";

/** Zod schemas of the arrival API. Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);

export const jobIdParams = z.object({ id });
export const arrivalParams = z.object({ id, arrivalId: id });

/** What reported the arrival: the technician pressing "I have arrived", or a device geofence event (§17.2). */
export const ARRIVAL_TRIGGERS = ["TECHNICIAN", "GEOFENCE"] as const;

/**
 * `POST /jobs/{id}/arrive`. A position (with accuracy and device clock) lets the server compare it with the job address;
 * without one the technician says why (§17.4) and a manager verifies. A geofence event always carries its position.
 */
export const arriveSchema = z
  .object({
    ...fieldEventEnvelope,
    trigger: z.enum(ARRIVAL_TRIGGERS).default("TECHNICIAN"),
    position: positionSchema.optional(),
    exception: locationExceptionSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.position && value.exception), { path: ["exception"], message: "Send a position or an exception, not both" })
  .refine((value) => value.position !== undefined || value.exception !== undefined, { path: ["exception"], message: "Send a position, or say why there is none" })
  .refine((value) => value.trigger !== "GEOFENCE" || value.position !== undefined, { path: ["position"], message: "A geofence event carries its position" });
export type ArriveInput = z.infer<typeof arriveSchema>;

/** `POST /jobs/{id}/start-work`: the technician starts the work (offline-safe). */
export const startWorkSchema = z.object({ ...fieldEventEnvelope }).strict();
export type StartWorkInput = z.infer<typeof startWorkSchema>;

/** `POST /jobs/{id}/navigation-opened`: informational; a position or an exception is optional. */
export const navigationOpenedSchema = z
  .object({ ...fieldEventEnvelope, position: positionSchema.optional(), exception: locationExceptionSchema.optional() })
  .strict()
  .refine((value) => !(value.position && value.exception), { path: ["exception"], message: "Send a position or an exception, not both" });
export type NavigationOpenedInput = z.infer<typeof navigationOpenedSchema>;

/** A manager's decision on an arrival. The reason is mandatory (§17.4, §21.3). */
export const verifyArrivalSchema = z.object({ decision: z.enum(["VERIFIED", "REJECTED"]), note: z.string().trim().min(1).max(500) }).strict();
export type VerifyArrivalInput = z.infer<typeof verifyArrivalSchema>;
