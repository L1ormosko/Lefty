import { z } from "zod";
import { pageArgs, pageQuerySchema, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { toCoachingRecordView, type CoachingRecordView } from "./coaching-records";
import { toContextNoteView, type ContextNoteView } from "./context-notes";

/**
 * Self-service (spec 5.11, `/api/v1/me/*`): the caller reads the coaching notes and context notes about THEM that were
 * shared with them and are not archived. No module permission: the query is filtered on the caller's employee record (a
 * user without one sees nothing). Private notes never appear here, whatever else the caller holds.
 */

const id = z.string().trim().min(1).max(64);

export const ownCoachingRecordsQuerySchema = pageQuerySchema.extend({ metricValueId: id.optional() }).strict();
export type OwnCoachingRecordsQuery = z.infer<typeof ownCoachingRecordsQuerySchema>;

export const ownContextNotesQuerySchema = pageQuerySchema.extend({ metricValueId: id.optional() }).strict();
export type OwnContextNotesQuery = z.infer<typeof ownContextNotesQuerySchema>;

/** `GET /me/coaching-notes`: coaching notes about the caller that were shared with them, newest conversation first. */
export async function listOwnSharedCoachingRecords(actor: Actor, query: OwnCoachingRecordsQuery): Promise<Page<CoachingRecordView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.coachingRecord.findMany({
      where: {
        tenantId: actor.tenantId,
        employeeId,
        sharedWithEmployee: true,
        archivedAt: null,
        ...(query.metricValueId ? { metricValueId: query.metricValueId } : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toCoachingRecordView), page: page.page };
  });
}

/** `GET /me/context-notes`: managers' context notes on the caller's metrics that were shared with them, newest first. */
export async function listOwnSharedContextNotes(actor: Actor, query: OwnContextNotesQuery): Promise<Page<ContextNoteView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.metricContextNote.findMany({
      where: {
        tenantId: actor.tenantId,
        employeeId,
        sharedWithEmployee: true,
        archivedAt: null,
        ...(query.metricValueId ? { metricValueId: query.metricValueId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toContextNoteView), page: page.page };
  });
}
