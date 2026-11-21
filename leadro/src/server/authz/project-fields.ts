import type { AccessDecision } from "./types";

/**
 * Maps EVERY projectable record field to the field set that protects it, e.g.
 * `{ name: "base", salary: "financial" }`. Use the central maps in `field-maps.ts`. A field that is
 * not listed is never returned (fail closed): a new column stays hidden until someone classifies it.
 */
export type FieldMap = Record<string, string>;

/**
 * Returns a copy of `record` containing only the fields the decision's `fieldSets` allow.
 * Every route that returns a record guarded by `can` / `requirePermission` should send
 * `projectFields(record, decision, FIELD_MAP)`, never the raw record: `allowed: true` on a
 * field-limited grant (Finance, Dispatcher) does not mean the whole record may leave the server.
 *
 * `decision.fieldSets` is only meaningful when `can` was given the record (`resource`). Unmapped
 * fields are dropped, and a denied decision projects to an empty object (fail closed).
 */
export function projectFields<T extends Record<string, unknown>>(
  record: T,
  decision: Pick<AccessDecision, "allowed" | "fieldSets">,
  fieldMap: FieldMap,
): Partial<T> {
  if (!decision.allowed) return {};
  const result: Partial<T> = {};
  for (const key of Object.keys(record) as Array<keyof T & string>) {
    const set = Object.hasOwn(fieldMap, key) ? fieldMap[key] : undefined;
    if (set !== undefined && decision.fieldSets.includes(set)) result[key] = record[key];
  }
  return result;
}
