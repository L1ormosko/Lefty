import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope, type ResourceRef } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { financeJobRef, financeJobScopeColumns } from "@/server/ledger";
import type { ListPaymentsQuery } from "./schemas";
import { loadPaymentWithJob, toPaymentView, type PaymentView } from "./store";

/** Payment reads (`finance_payments.view`). A payment's scope follows its job's current unit / legal entity. */

/** One page of payments, newest first (`createdAt desc, id desc`). */
export async function listPayments(actor: Actor, query: ListPaymentsQuery): Promise<Page<PaymentView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_payments.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_payments.view", now);
    const filters: Prisma.PaymentWhereInput[] = [];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.outcomeId) filters.push({ outcomeId: query.outcomeId });
    if (query.status) filters.push({ status: query.status });
    if (query.method) filters.push({ method: query.method });
    if (query.origin) filters.push({ origin: query.origin });
    const rows = await tx.payment.findMany({
      where: withinScope<Prisma.PaymentWhereInput>({ job: buildScopeWhere(scope, financeJobScopeColumns, now) }, { tenantId: actor.tenantId, AND: filters }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toPaymentView), page: page.page };
  });
}

/** One payment (outside the caller's scope = 404). */
export async function getPayment(actor: Actor, paymentId: string): Promise<PaymentView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_payments.view");
    const { payment, job } = await loadPaymentWithJob(tx, actor.tenantId, paymentId);
    await enforceInTx(tx, actor, "finance_payments.view", financeJobRef(job));
    return toPaymentView(payment);
  });
}

/** Route resolver: a payment's authorization reference (its job's unit), or null when it does not exist. */
export async function paymentResourceRef(tx: TenantTx, tenantId: string, paymentId: string): Promise<ResourceRef | null> {
  const payment = await tx.payment.findFirst({ where: { id: paymentId, tenantId }, select: { job: { select: { orgUnitId: true } } } });
  return payment ? financeJobRef(payment.job) : null;
}
