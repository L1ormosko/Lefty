import { stringifyJson } from "./money";

/**
 * Audit events record the changed fields only (docs/API_CONVENTIONS.md). Given the stored record
 * and the requested patch, returns the previous and new value of every field that actually
 * differs; an empty `changedKeys` means the patch is a no-op.
 *
 * Values are compared by their JSON form, which is what the audit column stores (Dates become ISO
 * strings, JSON columns compare structurally).
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  patch: Partial<Record<keyof T, unknown>>,
): { changedKeys: Array<keyof T & string>; previous: Record<string, unknown>; next: Record<string, unknown> } {
  const changedKeys: Array<keyof T & string> = [];
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof T & string>) {
    const requested = patch[key];
    if (requested === undefined) continue; // not part of the patch
    if (stringifyJson(before[key] ?? null) === stringifyJson(requested ?? null)) continue; // bigint-safe (money)
    changedKeys.push(key);
    previous[key] = before[key] ?? null;
    next[key] = requested ?? null;
  }
  return { changedKeys, previous, next };
}
