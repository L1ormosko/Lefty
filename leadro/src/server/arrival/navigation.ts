import type { Actor, RequestContext } from "@/server/core";
import { recordLocationEvent, type RecordedEventResult } from "@/server/location";
import type { NavigationOpenedInput } from "./schemas";

/**
 * "Navigation opened" (§8.3): the technician opened the maps app for a job. A pure location event: it never changes the
 * job status and never counts as arrival. This is the location module's own technician flow (assignment check,
 * accuracy, device time, idempotent `clientEventId`, response without coordinates) behind the job-scoped route.
 */
export const recordNavigationOpened = (actor: Actor, ctx: RequestContext, jobId: string, input: NavigationOpenedInput): Promise<RecordedEventResult> =>
  recordLocationEvent(actor, ctx, { ...input, kind: "NAVIGATION_OPENED", jobId });
