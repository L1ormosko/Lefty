import { ForbiddenError } from "@/server/core";
import type { FieldMap } from "./project-fields";
import type { AccessDecision } from "./types";

/**
 * Which fields a WRITE grant lets its holder change.
 *
 * A write grant's `conditions.fields` names a field set (`status`, `execution`...) and the decision
 * returns it in `fieldSets`. Field maps classify fields for READING (one tag per field); the narrow
 * write sets are explicit allowlists below, so a Technician's `{fields:"execution"}` grant means
 * exactly `JOB_EXECUTION_FIELDS`, nothing more. A plain grant (`base`) may change every non-sensitive
 * field of the record's field map; sensitive sets (`financial`, `billing`) only when named.
 */
export type WriteAllowlists = Readonly<Record<string, readonly string[]>>;

/** Lead fields a holder of `leads.edit {fields:"status"}` may change: the lifecycle status and its reason only. */
export const LEAD_STATUS_FIELDS = ["status", "closedReason"] as const;

/** Job fields a holder of `jobs.edit {fields:"execution"}` may change: progression and field notes, never scheduling, assignment or money. */
export const JOB_EXECUTION_FIELDS = ["status", "statusReason", "startedAt", "completedAt", "instructions"] as const;

export const LEAD_WRITE_ALLOWLISTS: WriteAllowlists = { status: LEAD_STATUS_FIELDS };
export const JOB_WRITE_ALLOWLISTS: WriteAllowlists = { execution: JOB_EXECUTION_FIELDS };

/** The set of field names the decision allows to change (empty when denied). */
export function writableFields(
  decision: Pick<AccessDecision, "allowed" | "fieldSets">,
  fieldMap: FieldMap,
  allowlistByTag: WriteAllowlists = {},
): Set<string> {
  const result = new Set<string>();
  if (!decision.allowed) return result;
  for (const tag of decision.fieldSets) {
    const listed = Object.hasOwn(allowlistByTag, tag) ? allowlistByTag[tag] : undefined;
    if (listed) {
      for (const field of listed) result.add(field);
      continue;
    }
    // `base` or a sensitive tag: the map's fields carrying exactly that tag. Unknown tags grant nothing.
    for (const [field, fieldTag] of Object.entries(fieldMap)) if (fieldTag === tag) result.add(field);
  }
  return result;
}

/**
 * Throws ForbiddenError when `changedFields` contains a field the decision does not let the caller
 * write (including unmapped/unknown fields). Call it with the decision of the write permission (e.g.
 * `jobs.edit`) for the specific record, before applying an update. Never lists values, only names.
 */
export function assertWritableFields(
  decision: Pick<AccessDecision, "allowed" | "fieldSets">,
  changedFields: readonly string[],
  fieldMap: FieldMap,
  allowlistByTag: WriteAllowlists = {},
): void {
  const writable = writableFields(decision, fieldMap, allowlistByTag);
  const denied = changedFields.filter((field) => !writable.has(field));
  if (denied.length > 0) {
    throw new ForbiddenError({ message: `You may not change: ${denied.join(", ")}.` });
  }
}
