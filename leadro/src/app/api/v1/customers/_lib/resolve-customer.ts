import type { ResourceResolver } from "@/server/authz";
import { customerResourceRef } from "@/server/customers";

/**
 * `requirePermission` resolver for every `/customers/{id}/...` route: loads the customer's scope
 * attributes (service area, assigned employees, record sets) from the database inside the check's own
 * transaction. A missing customer resolves to `null`, which the gate turns into a 404.
 */
export const resolveCustomer: ResourceResolver<{ params: { id: string } }> = (actor, { params }, tx) =>
  customerResourceRef(tx, actor.tenantId, params.id);
