import { auditContextFields, recordAudit } from "@/server/audit";
import { LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS, assertWritableFields, canInTx, enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { assertCustomerActive, customerResourceRef } from "@/server/customers";
import { withTenant, type TenantTx } from "@/server/db";
import { isClosedStatus } from "@/lib/lead-lifecycle";
import { confirmLeadCustomerFlag } from "./duplicates";
import { leadResourceRef } from "./lead-access";
import { leadViewAfterWrite } from "./lead-view";
import type { LinkCustomerInput } from "./schemas";

/**
 * The customer a lead belongs to must exist, be active, be visible to the caller and own the address (§6.1, customers
 * README: archived customers take no new work). A customer the caller may not view is a 404, like any hidden record.
 * The work about to be attached makes the customer a member of the record sets in `assumeSets` (a linked lead makes it
 * "lead_related"; a conversion also makes it "job_related"), so visibility is judged as if it already were: a
 * set-qualified grant (Dispatcher: `job_related`) must not hide the very customer the caller is about to create a job for.
 */
export async function assertCustomerUsableForLead(
  tx: TenantTx,
  actor: Actor,
  customerId: string,
  customerAddressId?: string,
  assumeSets: readonly string[] = ["lead_related"],
): Promise<void> {
  await assertCustomerActive(tx, actor.tenantId, customerId);
  const ref = await customerResourceRef(tx, actor.tenantId, customerId);
  if (!ref) throw new NotFoundError();
  const decision = await canInTx(tx, actor, "customers.view", { ...ref, sets: [...new Set([...(ref.sets ?? []), ...assumeSets])] });
  if (!decision.allowed) throw new NotFoundError();
  if (customerAddressId) {
    const address = await tx.customerAddress.findFirst({
      where: { id: customerAddressId, customerId, tenantId: actor.tenantId, archivedAt: null },
      select: { id: true },
    });
    if (!address) throw new ValidationError({ message: "The address does not belong to this customer.", field: "customerAddressId" });
  }
}

/**
 * Links the lead to an existing customer (and optionally one of its service addresses). Linking is a human decision
 * about identity, so an OPEN lead-customer duplicate flag of the pair is closed as CONFIRMED_DUPLICATE. Closed
 * (converted, lost...) and archived leads keep the customer they had. Needs `leads.edit` over the lead.
 */
export async function linkLeadCustomer(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  input: LinkCustomerInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.edit");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "leads.edit", ref);
    assertWritableFields(decision, ["customerId", "customerAddressId"], LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS);

    const lead = await tx.lead.findFirst({ where: { id: leadId, tenantId: actor.tenantId }, select: { status: true, archivedAt: true, customerId: true, customerAddressId: true } });
    if (!lead) throw new NotFoundError();
    if (lead.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot be changed. Restore it first." });
    if (isClosedStatus(lead.status)) throw new InvalidStateTransitionError({ message: `A ${lead.status} lead keeps its customer.` });

    await assertCustomerUsableForLead(tx, actor, input.customerId, input.customerAddressId);
    // Switching customers drops the old customer's address; staying with the same customer keeps it unless a new one is given.
    const customerAddressId = input.customerAddressId ?? (lead.customerId === input.customerId ? lead.customerAddressId : null);
    await tx.lead.update({ where: { id: leadId }, data: { customerId: input.customerId, customerAddressId } });
    await confirmLeadCustomerFlag(tx, actor, leadId, input.customerId);
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead.link_customer",
      targetType: "Lead",
      targetId: leadId,
      previousValue: { customerId: lead.customerId, customerAddressId: lead.customerAddressId },
      newValue: { customerId: input.customerId, customerAddressId },
    });
    return leadViewAfterWrite(tx, actor, leadId);
  });
}
