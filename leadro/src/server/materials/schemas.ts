import { z } from "zod";
import { currencyCodeSchema, moneyAmountSchema } from "@/lib/money";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the materials API (`/api/v1/materials/**`). */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

export const materialIdParams = z.object({ id });
export const costVersionParams = z.object({ id, versionId: id });
export const jobIdParams = z.object({ jobId: id });
export const usageIdParams = z.object({ usageId: id });

/** Same shape as the DB CHECK `material_code_format`: stable, lower-case, unique per tenant. */
const code = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "lower-case letters, digits, . _ -");

export const createMaterialSchema = z
  .object({
    code,
    name: text(200),
    description: text(2000).optional(),
    unit: text(30).default("each"),
    supplier: text(200).optional(),
  })
  .strict();
export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;

/** Catalog data only; the cost is never edited, it is a new version (`POST /materials/{id}/costs`). `null` clears. */
export const updateMaterialSchema = z
  .object({
    name: text(200).optional(),
    description: text(2000).nullable().optional(),
    unit: text(30).optional(),
    supplier: text(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Nothing to change." });
export type UpdateMaterialInput = z.infer<typeof updateMaterialSchema>;

export const archiveMaterialSchema = z.object({ reason: text(500).optional() }).strict();
export type ArchiveMaterialInput = z.infer<typeof archiveMaterialSchema>;

const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

/** The catalog, by code. Archived materials only with `includeArchived=true`. */
export const listMaterialsQuerySchema = pageQuerySchema.extend({
  includeArchived: booleanQuery.default("false"),
  q: z.string().trim().min(1).max(100).optional(),
});
export type ListMaterialsQuery = z.infer<typeof listMaterialsQuerySchema>;

/**
 * A proposed cost: `unitCostMinor` per the material's unit, in `currency`, effective from `effectiveFrom` (ISO-8601 with
 * offset). Approval (when a policy applies) does not move the date: the version takes effect on `effectiveFrom`.
 */
export const proposeCostSchema = z
  .object({
    unitCostMinor: moneyAmountSchema,
    currency: currencyCodeSchema,
    effectiveFrom: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
    note: text(500).optional(),
  })
  .strict();
export type ProposeCostInput = z.infer<typeof proposeCostSchema>;

export const withdrawCostSchema = z.object({ reason: text(500) }).strict();
export type WithdrawCostInput = z.infer<typeof withdrawCostSchema>;

export const MATERIAL_COST_STATUSES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"] as const;

/** A material's cost history, newest version first. */
export const listCostVersionsQuerySchema = pageQuerySchema.extend({ status: z.enum(MATERIAL_COST_STATUSES).optional() });
export type ListCostVersionsQuery = z.infer<typeof listCostVersionsQuerySchema>;

/**
 * Costing one usage line. `materialId` links a free-text line to the catalog (only while it is not linked yet); without it
 * the line's own link or its `materialRef` (read as a catalog code) is used.
 */
export const costUsageSchema = z.object({ materialId: id.optional() }).strict();
export type CostUsageInput = z.infer<typeof costUsageSchema>;

export const costJobMaterialsSchema = z.object({}).strict();
