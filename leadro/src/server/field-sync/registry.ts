import type { Actor, RequestContext } from "@/server/core";

/**
 * Registry of the event types the sync endpoint can apply (§8.7). Each field module owns the meaning of its event and
 * registers a handler for it; the sync module itself only orders, gates and reports. A module that arrives later (arrival
 * verification, recovery) plugs in with `registerFieldSyncHandler` and needs no change here.
 */

/** One event of a batch, as the device sent it (already validated for shape; the handler validates the payload). */
export interface FieldSyncEvent {
  clientEventId: string;
  /** Dotted lower-case type, e.g. `job.note`, `shift.start`. */
  type: string;
  /** When it happened on the device. */
  occurredAt: Date;
  /** The job the event is about, for job-scoped types. */
  jobId?: string;
  /** The type's own fields (what the matching REST endpoint takes as its body, without the offline envelope). */
  payload: Record<string, unknown>;
}

export interface FieldSyncCall {
  actor: Actor;
  ctx: RequestContext;
  event: FieldSyncEvent;
}

/**
 * Applies one event by calling the owning module's normal service function (which runs it through the shared offline
 * gate: idempotent per `(employee, clientEventId)`). It returns what the REST endpoint would have answered, or throws
 * the module's usual `AppError` (the batch turns it into this event's result and carries on).
 */
export type FieldSyncHandler = (call: FieldSyncCall) => Promise<unknown>;

const TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const handlers = new Map<string, FieldSyncHandler>();

/**
 * Registers the handler of an event type. A type has exactly one owner: registering it twice is a programming error and
 * throws, so two modules cannot silently shadow each other.
 */
export function registerFieldSyncHandler(type: string, handler: FieldSyncHandler): void {
  if (!TYPE_PATTERN.test(type)) throw new Error(`Field sync type "${type}" must be a dotted lower-case key like "job.note"`);
  if (handlers.has(type)) throw new Error(`A field sync handler for "${type}" is already registered`);
  handlers.set(type, handler);
}

export const findFieldSyncHandler = (type: string): FieldSyncHandler | undefined => handlers.get(type);

/** The registered types, sorted (diagnostics and the API reference). */
export const registeredFieldSyncTypes = (): string[] => [...handlers.keys()].sort();

/** Removes every handler. Tests only: the built-in ones are registered again by `registerBuiltInFieldSyncHandlers`. */
export function clearFieldSyncHandlers(): void {
  handlers.clear();
}
