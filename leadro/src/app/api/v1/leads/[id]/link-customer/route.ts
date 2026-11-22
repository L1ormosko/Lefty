import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { leadIdParams, linkCustomerSchema, linkLeadCustomer } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/link-customer: attach the lead to an existing customer (and one of its addresses). */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: linkCustomerSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.edit", resolveLead),
  handler: async ({ ctx, input }) => ok(await linkLeadCustomer(actorOf(ctx), ctx, input.params.id, input.body)),
});
