import type { ResourceResolver } from "@/server/authz";
import { leadResourceRef } from "@/server/leads";

/**
 * `requirePermission` resolver for every `/leads/{id}/...` route: loads the lead's scope attributes (service area, current
 * owner, record sets) from the database inside the check's own transaction. A missing lead resolves to `null`, which the
 * gate turns into a 404, exactly like a lead outside the caller's scope.
 */
export const resolveLead: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) =>
  leadResourceRef(tx, actor.tenantId, params.id);
