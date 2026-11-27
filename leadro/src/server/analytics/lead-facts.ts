import type { Prisma, RecoveryStatus } from "@prisma/client";
import type { KpiFact } from "@/lib/kpi-aggregation";
import { MAX_SOURCE_ROWS, assertWithinRowCap, inChunks, rangeOf, type KpiComputeContext, type KpiFactLoader } from "./compute-context";

/**
 * Fact loaders of the lead KPIs (volume and conversion by source, lead response time) and the recovery outcomes (spec 9.7,
 * 13.1). Recovery money keeps CONFIRMED amounts (recorded when a recovery was confirmed) and ESTIMATES (open cases) in separate
 * KPIs; nothing adds them together.
 */

const take = MAX_SOURCE_ROWS + 1;
const DECIDED: RecoveryStatus[] = ["RECOVERED", "NOT_RECOVERED", "CLOSED"];

/** Leads created in the range, duplicates excluded (a duplicate is the same request entered twice). */
async function leadsCreatedInRange<S extends Prisma.LeadSelect>(context: KpiComputeContext, select: S) {
  return assertWithinRowCap(
    await context.tx.lead.findMany({
      where: context.where<Prisma.LeadWhereInput>({ tenantId: context.tenantId, createdAt: rangeOf(context), status: { not: "DUPLICATE" } }),
      select,
      orderBy: { id: "asc" },
      take,
    }),
  );
}

/** Recovery cases whose lost visit (`outcomeAt`) is in the range, optionally narrowed. */
async function casesInRange<S extends Prisma.LeadRecoveryCaseSelect>(context: KpiComputeContext, select: S, extra: Prisma.LeadRecoveryCaseWhereInput) {
  return assertWithinRowCap(
    await context.tx.leadRecoveryCase.findMany({
      where: context.where<Prisma.LeadRecoveryCaseWhereInput>({ tenantId: context.tenantId, outcomeAt: rangeOf(context), ...extra }),
      select,
      orderBy: { id: "asc" },
      take,
    }),
  );
}

const leadVolume: KpiFactLoader = async (context) =>
  (await leadsCreatedInRange(context, { id: true, createdAt: true, orgUnitId: true, sourceId: true })).map((lead) => ({
    recordId: lead.id,
    at: lead.createdAt,
    orgUnitId: lead.orgUnitId,
    breakdownId: lead.sourceId,
  }));

const leadConversion: KpiFactLoader = async (context) =>
  (await leadsCreatedInRange(context, { id: true, createdAt: true, orgUnitId: true, sourceId: true, status: true })).map((lead) => ({
    recordId: lead.id,
    at: lead.createdAt,
    orgUnitId: lead.orgUnitId,
    breakdownId: lead.sourceId,
    hit: lead.status === "CONVERTED",
  }));

const leadResponseTime: KpiFactLoader = async (context) => {
  const leads = await leadsCreatedInRange(context, { id: true, createdAt: true, orgUnitId: true });
  const attempts = await inChunks(
    leads.map((lead) => lead.id),
    (chunk) =>
      context.tx.leadInteraction.groupBy({
        by: ["leadId"],
        where: { tenantId: context.tenantId, leadId: { in: chunk }, kind: "CONTACT_ATTEMPT", direction: "OUTBOUND" },
        _min: { occurredAt: true },
      }),
  );
  const firstAttempt = new Map(attempts.map((row) => [row.leadId, row._min.occurredAt]));
  return leads.flatMap((lead) => {
    const attemptAt = firstAttempt.get(lead.id);
    const ms = attemptAt ? attemptAt.getTime() - lead.createdAt.getTime() : -1;
    return ms >= 0 ? [{ recordId: lead.id, at: lead.createdAt, orgUnitId: lead.orgUnitId, durationMs: ms }] : [];
  });
};

const recoveryRate: KpiFactLoader = async (context) =>
  (await casesInRange(context, { id: true, outcomeAt: true, orgUnitId: true, recoveredAt: true }, { status: { in: DECIDED } })).map((recoveryCase) => ({
    recordId: recoveryCase.id,
    at: recoveryCase.outcomeAt,
    orgUnitId: recoveryCase.orgUnitId,
    hit: recoveryCase.recoveredAt !== null,
  }));

const confirmedRevenue: KpiFactLoader = async (context) =>
  (
    await casesInRange(
      context,
      { id: true, outcomeAt: true, orgUnitId: true, currency: true, recoveredAmountMinor: true },
      { status: { in: ["RECOVERED", "CLOSED"] }, recoveredAt: { not: null } },
    )
  ).map(
    (recoveryCase): KpiFact => ({
      recordId: recoveryCase.id,
      at: recoveryCase.outcomeAt,
      orgUnitId: recoveryCase.orgUnitId,
      currency: recoveryCase.currency,
      amountMinor: recoveryCase.recoveredAmountMinor ?? 0n,
    }),
  );

const estimatedValue: KpiFactLoader = async (context) =>
  (
    await casesInRange(context, { id: true, outcomeAt: true, orgUnitId: true, currency: true, estimatedValueMinor: true }, { status: { notIn: DECIDED } })
  ).map(
    (recoveryCase): KpiFact => ({
      recordId: recoveryCase.id,
      at: recoveryCase.outcomeAt,
      orgUnitId: recoveryCase.orgUnitId,
      currency: recoveryCase.currency,
      amountMinor: recoveryCase.estimatedValueMinor ?? 0n,
    }),
  );

export const LEAD_LOADERS: Record<string, KpiFactLoader> = {
  lead_response_time: leadResponseTime,
  lead_volume_by_source: leadVolume,
  lead_conversion_rate_by_source: leadConversion,
  recovery_rate: recoveryRate,
  recovery_confirmed_revenue: confirmedRevenue,
  recovery_estimated_value: estimatedValue,
};
