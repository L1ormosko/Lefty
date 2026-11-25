import type { Prisma } from "@prisma/client";
import { baseFieldMap, projectFields, type AccessDecision, type FieldMap } from "@/server/authz";

/**
 * What the materials API returns, and which field set protects each field (spec 11.4, 22.2).
 * Catalog data (code, name, unit, supplier, status) is `base`: everyone with `materials.view` (technicians pick from it).
 * Every cost (the current and the pending cost of a material, the whole version history, the cost of a job's materials)
 * is the opt-in `cost` set (`materials.cost_fields`): Owner and Finance Director by default, never COO or field roles.
 * Anything not listed is dropped (fail closed).
 */
export const COST_FIELD_SET = "cost";

export const MATERIAL_FIELD_MAP: FieldMap = {
  ...baseFieldMap(["id", "code", "name", "description", "unit", "supplier", "active", "archivedAt", "createdById", "createdAt", "updatedAt"]),
  currentCost: COST_FIELD_SET,
  pendingCost: COST_FIELD_SET,
};

export const materialRowSelect = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  description: true,
  unit: true,
  supplier: true,
  active: true,
  archivedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaterialSelect;
export type MaterialRow = Prisma.MaterialGetPayload<{ select: typeof materialRowSelect }>;

export const costVersionRowSelect = {
  id: true,
  materialId: true,
  versionNumber: true,
  unitCostMinor: true,
  currency: true,
  effectiveFrom: true,
  effectiveTo: true,
  status: true,
  approvalRequestId: true,
  note: true,
  createdById: true,
  createdAt: true,
  approvedAt: true,
} satisfies Prisma.MaterialCostVersionSelect;
export type CostVersionRow = Prisma.MaterialCostVersionGetPayload<{ select: typeof costVersionRowSelect }>;

/** The short form of a version shown on a material (current / pending cost). */
const costSummary = (version: CostVersionRow | null) =>
  version
    ? {
        versionId: version.id,
        versionNumber: version.versionNumber,
        unitCostMinor: version.unitCostMinor,
        currency: version.currency,
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
        status: version.status,
        approvalRequestId: version.approvalRequestId,
      }
    : null;

/**
 * A material as the caller may see it. `currentCost` is the APPROVED version in effect now (null before the first one takes
 * effect), `pendingCost` the version waiting for approval; both are projected away without the `cost` set.
 */
export function materialView(
  row: MaterialRow,
  costs: { current: CostVersionRow | null; pending: CostVersionRow | null },
  decision: Pick<AccessDecision, "allowed" | "fieldSets">,
): Record<string, unknown> {
  const { tenantId: _tenantId, ...rest } = row;
  return projectFields({ ...rest, currentCost: costSummary(costs.current), pendingCost: costSummary(costs.pending) }, decision, MATERIAL_FIELD_MAP);
}

/** A cost version (only ever shown to holders of the `cost` set). */
export const costVersionView = (row: CostVersionRow): Record<string, unknown> => ({ ...row });

export const usageRowSelect = {
  id: true,
  tenantId: true,
  jobId: true,
  employeeId: true,
  name: true,
  materialRef: true,
  materialId: true,
  costVersionId: true,
  unitCostMinor: true,
  extendedCostMinor: true,
  costCurrency: true,
  costedAt: true,
  quantity: true,
  unit: true,
  occurredAt: true,
  recordedAt: true,
} satisfies Prisma.JobMaterialUsageSelect;
export type UsageRow = Prisma.JobMaterialUsageGetPayload<{ select: typeof usageRowSelect }>;

/** A usage line with its cost snapshot. `quantity` is a JSON number (three decimals at most, nothing is lost). */
export function usageCostView(row: UsageRow): Record<string, unknown> {
  return {
    usageId: row.id,
    jobId: row.jobId,
    employeeId: row.employeeId,
    name: row.name,
    materialRef: row.materialRef,
    materialId: row.materialId,
    quantity: Number(row.quantity),
    unit: row.unit,
    occurredAt: row.occurredAt,
    costed: row.costVersionId !== null,
    costVersionId: row.costVersionId,
    unitCostMinor: row.unitCostMinor,
    extendedCostMinor: row.extendedCostMinor,
    currency: row.costCurrency,
    costedAt: row.costedAt,
  };
}
