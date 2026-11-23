import { describe, expect, it } from "vitest";
import { DELAYED_BOUNDARY_THRESHOLD_MS, assessCapture, reviewStateAfterBoundary } from "@/lib/shift-rules";

describe("assessCapture", () => {
  it("accepts an accurate position as a clean device capture", () => {
    expect(assessCapture({ accuracyM: 20, maxAccuracyM: 100 })).toEqual({ source: "DEVICE_GPS", exception: null, reviewRequired: false });
  });

  it("turns a too-vague position into a POOR_SIGNAL exception for review, keeping the position", () => {
    expect(assessCapture({ accuracyM: 400, maxAccuracyM: 100 })).toEqual({ source: "DEVICE_GPS", exception: { code: "POOR_SIGNAL", note: null }, reviewRequired: true });
  });

  it("makes a boundary without a position a manual entry that needs review, with the stated reason", () => {
    expect(assessCapture({ exception: { code: "GPS_DISABLED", note: "  phone setting off " }, maxAccuracyM: 100 })).toEqual({
      source: "MANUAL",
      exception: { code: "GPS_DISABLED", note: "phone setting off" },
      reviewRequired: true,
    });
  });

  it("keeps the technician's own exception even with a good position (e.g. a delayed capture)", () => {
    expect(assessCapture({ accuracyM: 10, exception: { code: "DELAYED" }, maxAccuracyM: 100 })).toEqual({
      source: "DEVICE_GPS",
      exception: { code: "DELAYED", note: null },
      reviewRequired: true,
    });
  });

  it("raises DELAYED for a boundary reported later than the threshold, but not at or under it", () => {
    expect(assessCapture({ accuracyM: 10, maxAccuracyM: 100, delayedByMs: DELAYED_BOUNDARY_THRESHOLD_MS + 1 })).toEqual({
      source: "DEVICE_GPS",
      exception: { code: "DELAYED", note: null },
      reviewRequired: true,
    });
    expect(assessCapture({ accuracyM: 10, maxAccuracyM: 100, delayedByMs: DELAYED_BOUNDARY_THRESHOLD_MS })?.exception).toBeNull();
    // a stated reason wins over the server's own observation
    expect(assessCapture({ exception: { code: "DEVICE_OFFLINE" }, maxAccuracyM: 100, delayedByMs: 3_600_000 })?.exception?.code).toBe("DEVICE_OFFLINE");
  });

  it("refuses a blank capture: neither position nor reason", () => {
    expect(assessCapture({ maxAccuracyM: 100 })).toBeNull();
  });
});

describe("reviewStateAfterBoundary", () => {
  it("opens a review for a new exception, even over an earlier decision", () => {
    expect(reviewStateAfterBoundary(null, true)).toBe("PENDING");
    expect(reviewStateAfterBoundary("APPROVED", true)).toBe("PENDING");
  });
  it("leaves the state alone for a clean boundary", () => {
    expect(reviewStateAfterBoundary(null, false)).toBeNull();
    expect(reviewStateAfterBoundary("APPROVED", false)).toBe("APPROVED");
    expect(reviewStateAfterBoundary("PENDING", false)).toBe("PENDING");
  });
});
