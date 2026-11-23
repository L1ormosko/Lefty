import { findCoordinateKey } from "@/lib/location-rules";

/**
 * Guards an audit `previousValue` / `newValue` built by the shifts and location modules (spec 22.2: coordinates live only in
 * `LocationEvent`, where retention can purge them; the append-only audit log could never forget them). Returns the value
 * unchanged, or throws, which is a programming error caught by the first test that exercises the call.
 */
export function withoutCoordinates<T extends Record<string, unknown>>(value: T): T {
  const offending = findCoordinateKey(value);
  if (offending) throw new Error(`Audit values must not contain coordinates (found "${offending}")`);
  return value;
}
