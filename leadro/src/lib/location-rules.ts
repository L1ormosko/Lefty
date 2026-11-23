import { createHash } from "node:crypto";

/**
 * Pure rules for field events and location data (spec 8.1, 8.7, 17). No database, no framework.
 * The services in `src/server/location` and `src/server/shifts` apply them; tests pin them here.
 */

/** A device clock may run this far ahead of the server before the event is refused (spec 8.7: devices drift). */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** An offline event older than this is refused: a device that was dark for over a week should be reviewed by a person, not replayed. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3_600_000;

export type OccurredAtProblem = "IN_THE_FUTURE" | "TOO_OLD";

/** Is a device-reported `occurredAt` believable relative to the server clock? Null = fine. */
export function checkOccurredAt(occurredAt: Date, now: Date): OccurredAtProblem | null {
  const difference = occurredAt.getTime() - now.getTime();
  if (difference > MAX_CLOCK_SKEW_MS) return "IN_THE_FUTURE";
  if (-difference > MAX_EVENT_AGE_MS) return "TOO_OLD";
  return null;
}

/**
 * Is a position precise enough to be used (verification, presence)? Smaller accuracy radius = better. An unusable
 * position is still recorded (spec 17.2 keeps the accuracy), it just never counts as evidence (spec 26.5).
 */
export function isAccurateEnough(accuracyM: number | null | undefined, maxAccuracyM: number): boolean {
  return typeof accuracyM === "number" && accuracyM >= 0 && accuracyM <= maxAccuracyM;
}

/** Is an event recent enough to say where someone is NOW (presence, spec 26.5)? */
export function isFreshEnough(serverTime: Date, now: Date, maxAgeMinutes: number): boolean {
  const ageMs = now.getTime() - serverTime.getTime();
  return ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= maxAgeMinutes * 60_000;
}

/** Object keys that look like raw coordinates. They never belong in JSON columns or audit values (ERD "Contracts for JSON"). */
const COORDINATE_KEY = /^(lat|lng|lon|long|latitude|longitude|coords?|coordinates?|position|gps)$/i;

/**
 * The path of the first key that looks like a coordinate anywhere in `value` (`"payload.coords"`), or null.
 * Writers of JSON columns (field-event payloads, audit values) call it so coordinates stay in `LocationEvent`,
 * where the retention purge can reach them.
 */
export function findCoordinateKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCoordinateKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (COORDINATE_KEY.test(key)) return childPath;
    const found = findCoordinateKey(child, childPath);
    if (found) return found;
  }
  return null;
}

/** JSON with object keys sorted at every depth, so equal content always serialises equally. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 (hex) of the canonical content of a field event (spec 25.3). A replay with the same `clientEventId` and
 * the same hash is a duplicate; a different hash is a CONFLICT. Hash only what the event MEANS (type, target,
 * times, values), never transport details such as batch ids. The hash is one-way, so hashing coordinates does not store them.
 */
export function hashFieldEventContent(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
