import type { ResourceResolver } from "@/server/authz";
import { caseResourceRefById, ruleResourceRefById } from "@/server/recovery";

/** `requirePermission` resolver for `/lead-recovery/cases/{id}/...`: the case's scope attributes, read inside the check's own transaction. A missing case is a 404. */
export const resolveCase: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) => caseResourceRefById(tx, actor.tenantId, params.id);

/** Same for `/lead-recovery/rules/{id}/...`. */
export const resolveRule: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) => ruleResourceRefById(tx, actor.tenantId, params.id);
