import type { PaymentIntakeEvent, Prisma } from "@prisma/client";
import { enforceInTx } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import type { ListIntakeEventsQuery } from "./schemas";
import { configuredPaymentProviders } from "./provider";

/**
 * Reading the intake log (`finance_payments.view` with a TENANT scope: an event may name no job, or a job that does not
 * exist, so it has no unit to scope by). The log holds hashes and normalized fields only, never raw provider payloads.
 */

export type IntakeEventView = Omit<PaymentIntakeEvent, "tenantId">;

/** One page of intake events, newest first (`receivedAt desc, id desc`). */
export async function listIntakeEvents(actor: Actor, query: ListIntakeEventsQuery): Promise<Page<IntakeEventView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_payments.view", {});
    const where: Prisma.PaymentIntakeEventWhereInput = {
      tenantId: actor.tenantId,
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await tx.paymentIntakeEvent.findMany({ where, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(({ tenantId: _tenantId, ...event }) => event), page: page.page };
  });
}

/**
 * Which payment providers this deployment can accept events from, so a client can say truthfully that none is set up
 * (spec 28.3). Capability check `finance_payments.view`. Empty in this build.
 */
export async function listPaymentProviders(actor: Actor): Promise<{ configured: string[] }> {
  await withTenant(actor.tenantId, (tx) => enforceInTx(tx, actor, "finance_payments.view"));
  return { configured: configuredPaymentProviders() };
}
