import { z } from "zod";
import type { Prisma } from "@prisma/client";

/**
 * Qualifiers stored in `RolePermission.conditions` for the "Limited" cells of the §4.5 matrix.
 *
 * - `fields`: the grant reveals ONLY this field set (e.g. Finance sees `financial` fields of
 *   employees; a Dispatcher sees `availability`).
 * - `excludeFields`: the grant reveals everything EXCEPT these field sets (HR: no `financial`).
 * - `set`: the grant covers only records of this named set (e.g. `job_related` customers). The
 *   caller supplies the sets a record belongs to (`ResourceRef.sets`).
 *
 * Unknown keys make the whole grant unusable (fail closed): an engine that cannot understand a
 * restriction must not ignore it.
 */
const conditionsSchema = z
  .object({
    fields: z.string().min(1).optional(),
    excludeFields: z.array(z.string().min(1)).optional(),
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

/** Whether a grant with these conditions reveals the field set `tag`. */
export function conditionsAllowFieldSet(conditions: GrantConditions, tag: string): boolean {
  if (conditions.fields !== undefined && conditions.fields !== tag) return false;
  if (conditions.excludeFields?.includes(tag)) return false;
  return true;
}
