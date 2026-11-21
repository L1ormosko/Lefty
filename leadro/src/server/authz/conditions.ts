import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { SENSITIVE_FIELD_CATEGORIES } from "./permission-catalog";

/** Field set of every non-sensitive field of a record. Sensitive sets are never part of it. */
export const BASE_FIELD_SET = "base";

const SENSITIVE_TAGS: ReadonlySet<string> = new Set(SENSITIVE_FIELD_CATEGORIES.map((category) => category.tag));

/**
 * Qualifiers stored in `RolePermission.conditions` for the "Limited" cells of the 4.5 matrix.
 *
 * - `fields`: the grant reveals ONLY this field set (Finance: `financial`; Dispatcher: `availability`).
 * - `includeFields`: the grant reveals the base fields PLUS these sensitive sets. Sensitive
 *   categories (financial, billing) are OPT-IN: without a grant naming them they stay hidden.
 * - `set`: the grant covers only records of this named set (e.g. `job_related` customers). The
 *   caller supplies the sets a record belongs to (`ResourceRef.sets`).
 *
 * Unknown keys make the whole grant unusable (fail closed): an engine that cannot understand a
 * restriction must not ignore it.
 */
const conditionsSchema = z
  .object({
    fields: z.string().min(1).optional(),
    includeFields: z.array(z.string().min(1)).optional(),
    set: z.string().min(1).optional(),
  })
  .strict();

export type GrantConditions = z.infer<typeof conditionsSchema>;

/** `null` means the stored conditions are malformed and the grant must be ignored. */
export function parseConditions(raw: Prisma.JsonValue | null | undefined): GrantConditions | null {
  if (raw === null || raw === undefined) return {};
  const parsed = conditionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The field sets a grant with these conditions reveals (or lets the holder change). */
export function grantFieldSets(conditions: GrantConditions): string[] {
  if (conditions.fields !== undefined) return [conditions.fields];
  return [BASE_FIELD_SET, ...(conditions.includeFields ?? [])];
}

/**
 * Whether a holder of field sets `held` may hand out a grant that reveals `required`.
 * Non-sensitive sets (availability, execution...) are covered by `base`; sensitive sets need to be
 * held explicitly.
 */
export function fieldSetsCover(held: string[], required: string[]): boolean {
  return required.every(
    (tag) => held.includes(tag) || (tag !== BASE_FIELD_SET && !SENSITIVE_TAGS.has(tag) && held.includes(BASE_FIELD_SET)),
  );
}
