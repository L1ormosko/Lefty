import type { ZodType, ZodTypeDef } from "zod";
import { arriveSchema, confirmArrival, startWork, startWorkSchema } from "@/server/arrival";
import { ValidationError } from "@/server/core";
import {
  recordAttachmentMetadata,
  recordAttachmentSchema,
  recordFieldNote,
  recordFieldNoteSchema,
  recordMaterialSchema,
  recordMaterialUsed,
  submitCompletion,
  submitCompletionSchema,
} from "@/server/field-execution";
import {
  cancelFollowUp,
  cancelFollowUpSchema,
  changeFollowUpStatus,
  changeFollowUpStatusSchema,
  completeFollowUp,
  completeFollowUpSchema,
} from "@/server/follow-ups";
import { transitionJob, transitionJobSchema } from "@/server/jobs";
import { recordJobOutcome, recordOutcomeSchema } from "@/server/job-outcomes";
import { recordLocationEvent, recordLocationEventSchema } from "@/server/location";
import { endShift, endShiftSchema, startShift, startShiftSchema } from "@/server/shifts";
import { findFieldSyncHandler, registerFieldSyncHandler, type FieldSyncCall, type FieldSyncHandler } from "./registry";

/**
 * The event types the field modules that exist today expose to the sync endpoint. Every handler builds the SAME input the
 * module's REST endpoint takes (the envelope of the batch event wins over anything in the payload), parses it with the
 * module's own Zod schema and calls the module's service, so an offline event and an online request take one code path
 * and one set of rules. A module added later registers its own types with `registerFieldSyncHandler`.
 */

/** The batch event's identity becomes the body's offline envelope: `clientEventId`, `occurredAt` (and the job where the body names it). */
function envelopeOf(call: FieldSyncCall): Record<string, unknown> {
  // `job.en_route` is the jobs transition endpoint with its target implied by the type.
  return { ...call.event.payload, ...(call.event.type === "job.en_route" ? { toStatus: "EN_ROUTE" } : {}), clientEventId: call.event.clientEventId, occurredAt: call.event.occurredAt.toISOString() };
}

/** A job-scoped event must name its job: the endpoint it replaces has the id in the path. */
function requireJobId(call: FieldSyncCall): string {
  if (!call.event.jobId) throw new ValidationError({ message: "This event type needs a jobId.", field: "jobId" });
  return call.event.jobId;
}

/** Parses with the module's schema; a bad payload is this event's VALIDATION_FAILED (the error mapper turns the ZodError into field issues). */
function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  return schema.parse(input);
}

const jobHandler =
  <T>(schema: ZodType<T, ZodTypeDef, unknown>, run: (call: FieldSyncCall, jobId: string, input: T) => Promise<unknown>): FieldSyncHandler =>
  (call) =>
    run(call, requireJobId(call), parse(schema, envelopeOf(call)));

/** A follow-up event names its task in `payload.followUpId`; the rest of the payload is the endpoint's body. */
const followUpHandler =
  <T>(schema: ZodType<T, ZodTypeDef, unknown>, run: (call: FieldSyncCall, followUpId: string, input: T) => Promise<unknown>): FieldSyncHandler =>
  (call) => {
    const { followUpId, ...rest } = envelopeOf(call);
    if (typeof followUpId !== "string" || followUpId.length === 0) throw new ValidationError({ message: "This event type needs payload.followUpId.", field: "payload.followUpId" });
    return run(call, followUpId, parse(schema, rest));
  };

const BUILT_IN: Record<string, FieldSyncHandler> = {
  // The technician's steps toward the visit: each is a job status change owned by the jobs / arrival services.
  "job.en_route": jobHandler(transitionJobSchema, ({ actor, ctx }, jobId, input) => transitionJob(actor, ctx, jobId, input)),
  "job.arrive": jobHandler(arriveSchema, ({ actor, ctx }, jobId, input) => confirmArrival(actor, ctx, jobId, input)),
  "job.start_work": jobHandler(startWorkSchema, ({ actor, ctx }, jobId, input) => startWork(actor, ctx, jobId, input)),
  "job.note": jobHandler(recordFieldNoteSchema, ({ actor, ctx }, jobId, input) => recordFieldNote(actor, ctx, jobId, input)),
  "job.material": jobHandler(recordMaterialSchema, ({ actor, ctx }, jobId, input) => recordMaterialUsed(actor, ctx, jobId, input)),
  "job.attachment": jobHandler(recordAttachmentSchema, ({ actor, ctx }, jobId, input) => recordAttachmentMetadata(actor, ctx, jobId, input)),
  "job.completion": jobHandler(submitCompletionSchema, ({ actor, ctx }, jobId, input) => submitCompletion(actor, ctx, jobId, input)),
  "job.outcome": jobHandler(recordOutcomeSchema, ({ actor, ctx }, jobId, input) => recordJobOutcome(actor, ctx, jobId, input)),
  // Follow-up tasks (a technician's own work items): the same services as the REST endpoints, idempotent per clientEventId.
  "follow_up.status": followUpHandler(changeFollowUpStatusSchema, ({ actor, ctx }, followUpId, input) => changeFollowUpStatus(actor, ctx, followUpId, input)),
  "follow_up.complete": followUpHandler(completeFollowUpSchema, ({ actor, ctx }, followUpId, input) => completeFollowUp(actor, ctx, followUpId, input)),
  "follow_up.cancel": followUpHandler(cancelFollowUpSchema, ({ actor, ctx }, followUpId, input) => cancelFollowUp(actor, ctx, followUpId, input)),
  "shift.start": (call) => startShift(call.actor, call.ctx, parse(startShiftSchema, envelopeOf(call))),
  // The technician's own shift only: ending someone else's shift is a manager action over HTTP, never an offline event.
  "shift.end": (call) => endShift(call.actor, call.ctx, undefined, parse(endShiftSchema, envelopeOf(call))),
  "location.departure": (call) => recordLocationEvent(call.actor, call.ctx, parse(recordLocationEventSchema, { ...envelopeOf(call), kind: "DEPARTURE", jobId: requireJobId(call) })),
  "location.navigation_opened": (call) =>
    recordLocationEvent(call.actor, call.ctx, parse(recordLocationEventSchema, { ...envelopeOf(call), kind: "NAVIGATION_OPENED", jobId: requireJobId(call) })),
};

/** Registers the built-in types that are not registered yet (safe to call again, e.g. after tests cleared the registry). */
export function registerBuiltInFieldSyncHandlers(): void {
  for (const [type, handler] of Object.entries(BUILT_IN)) {
    if (!findFieldSyncHandler(type)) registerFieldSyncHandler(type, handler);
  }
}
