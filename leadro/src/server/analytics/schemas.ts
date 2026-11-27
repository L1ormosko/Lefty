import { z } from "zod";
import { KPI_GRANULARITIES } from "@/lib/kpi-aggregation";
import { KPI_ORG_LEVELS } from "@/lib/kpi-catalog";

/** `YYYY-MM-DD`: a calendar date in the TENANT's time zone. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Not a real calendar date");

/**
 * Query of `GET /api/v1/analytics/kpis/{key}`. `from` / `to` are tenant-local dates, both included; required except for SNAPSHOT
 * KPIs (which ignore them). `period` buckets the range; `groupBy` rolls records up to an org level; `orgUnitId` narrows to one
 * unit and its descendants, always inside the viewer's own scope.
 */
export const kpiQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    period: z.enum(KPI_GRANULARITIES).default("TOTAL"),
    groupBy: z.enum(KPI_ORG_LEVELS).default("TENANT"),
    orgUnitId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type KpiQuery = z.infer<typeof kpiQuerySchema>;

export const kpiKeyParams = z.object({ key: z.string().trim().min(1).max(80) }).strict();
