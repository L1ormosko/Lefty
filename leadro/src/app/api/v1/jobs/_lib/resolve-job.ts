import type { ResourceResolver } from "@/server/authz";
import { jobResourceRef } from "@/server/jobs";

/**
 * `requirePermission` resolver for every `/jobs/{id}/...` route: loads the job's scope attributes
 * (service-area unit, assigned employees with team expansion) from the database inside the check's own
 * transaction. A missing job resolves to `null`, which the gate turns into a 404.
 */
export const resolveJob: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) =>
  jobResourceRef(tx, actor.tenantId, params.id);
