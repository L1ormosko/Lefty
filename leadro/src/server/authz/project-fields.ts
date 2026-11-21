import { BASE_FIELD_SET } from "./conditions";
import type { AccessDecision } from "./types";

/**
 * Maps record fields to the field set that protects them, e.g.
 * `{ salary: "financial", bankAccount: "financial", availability: "availability" }`.
 * Fields not listed belong to `base`.
 */
export type FieldMap = Record<string, string>;

/**
 * Returns a copy of `record` containing only the fields the decision's `fieldSets` allow.
 * Every route that returns a record guarded by `can` / `requirePermission` should send
 * `projectFields(record, decision, FIELD_MAP)`, never the raw record: `allowed: true` on a
 * field-limited grant (Finance, Dispatcher) does not mean the whole record may leave the server.
 * A denied decision projects to an empty object (fail closed).
 */
export function projectFields<T extends Record<string, unknown>>(
  record: T,
  decision: Pick<AccessDecision, "allowed" | "fieldSets">,
  fieldMap: FieldMap = {},
): Partial<T> {
  if (!decision.allowed) return {};
  const result: Partial<T> = {};
  for (const key of Object.keys(record) as Array<keyof T & string>) {
    const set = fieldMap[key] ?? BASE_FIELD_SET;
    if (decision.fieldSets.includes(set)) result[key] = record[key];
  }
  return result;
}
