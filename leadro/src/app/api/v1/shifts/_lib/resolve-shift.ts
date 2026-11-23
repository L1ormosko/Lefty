import type { ResourceResolver } from "@/server/authz";
import { shiftRef } from "@/server/shifts";

/**
 * `requirePermission` resolver for every `/shifts/{id}/...` route: loads the shift's scope attributes (placement
 * snapshot, legal employer, owner) from the database inside the check's own transaction. A missing shift resolves
 * to `null`, which the gate turns into a 404.
 */
export const resolveShift: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) => shiftRef(tx, actor.tenantId, params.id);
