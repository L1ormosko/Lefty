import { describe, expect, it } from "vitest";
import {
  MAX_CLOCK_SKEW_MS,
  MAX_EVENT_AGE_MS,
  checkOccurredAt,
  findCoordinateKey,
  hashFieldEventContent,
  isAccurateEnough,
} from "@/lib/location-rules";

const now = new Date("2026-11-23T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("checkOccurredAt", () => {
  it("accepts now, small clock drift and an hour-old offline event", () => {
    expect(checkOccurredAt(now, now)).toBeNull();
    expect(checkOccurredAt(new Date(now.getTime() + MAX_CLOCK_SKEW_MS), now)).toBeNull();
    expect(checkOccurredAt(minutesAgo(60), now)).toBeNull();
  });
  it("refuses a time clearly in the future and one older than the offline limit", () => {
    expect(checkOccurredAt(new Date(now.getTime() + MAX_CLOCK_SKEW_MS + 1), now)).toBe("IN_THE_FUTURE");
    expect(checkOccurredAt(new Date(now.getTime() - MAX_EVENT_AGE_MS - 1), now)).toBe("TOO_OLD");
  });
});

describe("isAccurateEnough", () => {
  it("uses the accuracy radius: smaller is better, unknown is never enough", () => {
    expect(isAccurateEnough(40, 100)).toBe(true);
    expect(isAccurateEnough(100, 100)).toBe(true);
    expect(isAccurateEnough(101, 100)).toBe(false);
    expect(isAccurateEnough(null, 100)).toBe(false);
    expect(isAccurateEnough(undefined, 100)).toBe(false);
  });
});

describe("findCoordinateKey", () => {
  it("finds coordinate-looking keys at any depth and names the path", () => {
    expect(findCoordinateKey({ a: { latitude: 1 } })).toBe("a.latitude");
    expect(findCoordinateKey({ list: [{ ok: 1 }, { Coords: [1, 2] }] })).toBe("list[1].Coords");
    expect(findCoordinateKey({ lng: 3 })).toBe("lng");
  });
  it("lets ids, codes and numbers through", () => {
    expect(findCoordinateKey({ shiftId: "s1", accuracyM: 12, kind: "SHIFT_START", distanceToJobM: 80 })).toBeNull();
    expect(findCoordinateKey(null)).toBeNull();
    expect(findCoordinateKey("latitude")).toBeNull();
  });
});

describe("hashFieldEventContent", () => {
  it("does not depend on key order or undefined members", () => {
    expect(hashFieldEventContent({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashFieldEventContent({ b: { d: [1, 2], c: 2 }, a: 1, e: undefined }));
  });
  it("changes when content changes, including dates", () => {
    const base = { type: "shift.start", at: new Date("2026-11-23T10:00:00Z") };
    expect(hashFieldEventContent(base)).not.toBe(hashFieldEventContent({ ...base, at: new Date("2026-11-23T10:00:01Z") }));
    expect(hashFieldEventContent(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("hashes bigint money exactly like the same safe-integer number (events stored before Phase 4 still replay)", () => {
    expect(hashFieldEventContent({ chargedAmountMinor: 45000n })).toBe(hashFieldEventContent({ chargedAmountMinor: 45000 }));
    expect(hashFieldEventContent({ a: 9_007_199_254_740_993n })).not.toBe(hashFieldEventContent({ a: 9_007_199_254_740_992n }));
  });
});
