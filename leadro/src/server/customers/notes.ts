import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ForbiddenError, NotFoundError, pageArgs, toPage, type Actor, type Page, type PageQuery, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { customerResourceRef } from "./customer-access";
import type { CreateNoteInput } from "./schemas";

/**
 * Customer notes (§6.1): an append-only log of what staff learned about the customer, each with its
 * author and time. Notes are not edited or deleted (what was said stays on record); a correction is
 * a new note. Reading needs `customers.view`; adding needs `customers.edit` with the `base` field set.
 */

const noteSelect = { id: true, customerId: true, authorId: true, body: true, createdAt: true } as const;

/** Notes of a customer, newest first. */
export async function listNotes(actor: Actor, customerId: string, query: PageQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "customers.view", ref);
    const rows = await tx.customerNote.findMany({
      where: { tenantId: actor.tenantId, customerId },
      select: noteSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

/** Adds a note authored by the caller. The audit event records the note id only (the text is in the note, not copied into the log). */
export async function addNote(actor: Actor, ctx: RequestContext, customerId: string, input: CreateNoteInput) {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.edit");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "customers.edit", ref);
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();

    const note = await tx.customerNote.create({
      data: { tenantId: actor.tenantId, customerId, authorId: actor.userId, body: input.body },
      select: noteSelect,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.note_add",
      targetType: "CustomerNote",
      targetId: note.id,
      newValue: { customerId },
    });
    return note;
  });
}
