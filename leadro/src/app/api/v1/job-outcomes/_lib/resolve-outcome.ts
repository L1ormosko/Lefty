import type { ResourceResolver } from "@/server/authz";
import { outcomeResourceRef } from "@/server/job-outcomes";

/** `requirePermission` resolver for `/job-outcomes/{id}`: an outcome is authorized through its job. Missing > 404. */
export const resolveOutcome: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) =>
  outcomeResourceRef(tx, actor.tenantId, params.id);
