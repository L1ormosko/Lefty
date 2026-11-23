import type { ResourceResolver } from "@/server/authz";
import { followUpResourceRefById } from "@/server/follow-ups";

/**
 * `requirePermission` resolver for every `/follow-ups/{id}/...` route: loads the task's scope attributes (service area,
 * assignee, creator) from the database inside the check's own transaction. A missing task resolves to `null`, which the
 * gate turns into a 404, exactly like a task outside the caller's scope. The target-access gate runs in the service.
 */
export const resolveFollowUp: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) =>
  followUpResourceRefById(tx, actor.tenantId, params.id);
