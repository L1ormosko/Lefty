import type { ResourceResolver } from "@/server/authz";
import { financeJobRefById, ledgerEntryJobRef, ledgerEntryRefById, outcomeFinanceRef } from "@/server/ledger";
import { paymentResourceRef } from "@/server/payments";
import { exceptionResourceRef, runResourceRef } from "@/server/reconciliation";

/**
 * `requirePermission` resolvers for the finance routes, so an out-of-scope record is a 404 AND an audited denial at the
 * route (the services re-check inside their own transaction).
 */

type IdParams = { params: { id: string } };

/** `/finance/jobs/{id}/...`: the job. */
export const resolveFinanceJob: ResourceResolver<IdParams> = (actor, { params }, tx) => financeJobRefById(tx, actor.tenantId, params.id);

/** `POST /finance/payments`: the job named in the body. */
export const resolveBodyJob: ResourceResolver<{ body: { jobId: string } }> = (actor, { body }, tx) => financeJobRefById(tx, actor.tenantId, body.jobId);

/** `/finance/payments/{id}/...`: the payment's job. */
export const resolvePayment: ResourceResolver<IdParams> = (actor, { params }, tx) => paymentResourceRef(tx, actor.tenantId, params.id);

/** `/finance/outcomes/{id}/...`: the outcome's job. */
export const resolveOutcomeJob: ResourceResolver<IdParams> = (actor, { params }, tx) => outcomeFinanceRef(tx, actor.tenantId, params.id);

/** `GET /finance/ledger/entries/{id}`: the entry's unit / legal entity snapshot. */
export const resolveLedgerEntry: ResourceResolver<IdParams> = (actor, { params }, tx) => ledgerEntryRefById(tx, actor.tenantId, params.id);

/** `POST /finance/ledger/entries/{id}/reverse`: the entry's job. */
export const resolveLedgerEntryJob: ResourceResolver<IdParams> = (actor, { params }, tx) => ledgerEntryJobRef(tx, actor.tenantId, params.id);

/** `/finance/reconciliation/exceptions/{id}/...`: the exception's unit at detection (none = tenant-level, TENANT scope only). */
export const resolveReconciliationException: ResourceResolver<IdParams> = (actor, { params }, tx) => exceptionResourceRef(tx, actor.tenantId, params.id);

/** `/finance/reconciliation/runs/{id}`: the run's legal entity (none = tenant-wide, TENANT scope only). */
export const resolveReconciliationRun: ResourceResolver<IdParams> = (actor, { params }, tx) => runResourceRef(tx, actor.tenantId, params.id);
