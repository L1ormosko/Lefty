import { describe, expect, it } from "vitest";
import { exceptionForReviewReason, judgeArrival } from "@/lib/arrival-rules";
import { TECHNICIAN_TARGET_STATUSES, canTransitionJob, isTechnicianFieldEventStep } from "@/lib/job-lifecycle";

const address = { latitude: 40, longitude: -89 };
const base = { address, radiusM: 150, maxAccuracyM: 100 };

describe("judgeArrival", () => {
  it("is a candidate verification inside the radius with a usable accuracy", () => {
    const result = judgeArrival({ ...base, position: { latitude: 40.0005, longitude: -89, accuracyM: 10 } });
    expect(result).toMatchObject({ verification: "WITHIN_RADIUS", reviewReason: null });
    expect(result.distanceM).toBeGreaterThan(50);
    expect(result.distanceM).toBeLessThan(60);
  });
  it("needs a manager when measured outside the radius", () => {
    const result = judgeArrival({ ...base, position: { latitude: 40.01, longitude: -89, accuracyM: 10 } });
    expect(result).toMatchObject({ verification: "OUTSIDE_RADIUS", reviewReason: "OUTSIDE_RADIUS" });
    expect(result.distanceM).toBeGreaterThan(1000);
  });
  it("never confirms with a vague fix, even when it lies on the address", () => {
    expect(judgeArrival({ ...base, position: { latitude: 40, longitude: -89, accuracyM: 500 } })).toMatchObject({ verification: "UNVERIFIED", reviewReason: "POOR_ACCURACY", distanceM: 0 });
  });
  it("does not confirm when the accuracy circle is not inside the radius", () => {
    const small = { ...base, radiusM: 30 };
    // 20 m away, but a 90 m accuracy radius: the device could be anywhere around the site.
    expect(judgeArrival({ ...small, position: { latitude: 40 + 20 / 111_200, longitude: -89, accuracyM: 90 } })).toMatchObject({ verification: "UNVERIFIED", reviewReason: "POOR_ACCURACY" });
    // 20 m away with 15 m accuracy: 35 m > 30 m.
    expect(judgeArrival({ ...small, position: { latitude: 40 + 20 / 111_200, longitude: -89, accuracyM: 15 } })).toMatchObject({ reviewReason: "POOR_ACCURACY" });
    // 20 m away with 10 m accuracy: inside.
    expect(judgeArrival({ ...small, position: { latitude: 40 + 20 / 111_200, longitude: -89, accuracyM: 10 } })).toMatchObject({ verification: "WITHIN_RADIUS", reviewReason: null });
  });
  it("cannot measure without a position or without address coordinates", () => {
    expect(judgeArrival({ ...base, position: null })).toEqual({ distanceM: null, verification: "UNVERIFIED", reviewReason: "NO_POSITION" });
    expect(judgeArrival({ ...base, address: { latitude: null, longitude: null }, position: { latitude: 40, longitude: -89, accuracyM: 5 } })).toMatchObject({
      verification: "UNVERIFIED",
      reviewReason: "ADDRESS_WITHOUT_COORDINATES",
    });
  });
  it("maps every review reason to a location exception", () => {
    expect(exceptionForReviewReason("OUTSIDE_RADIUS")).toBe("OUTSIDE_GEOFENCE");
    expect(exceptionForReviewReason("POOR_ACCURACY")).toBe("POOR_SIGNAL");
    expect(exceptionForReviewReason("NO_POSITION")).toBe("DEVICE_OFFLINE");
    expect(exceptionForReviewReason("ADDRESS_WITHOUT_COORDINATES")).toBe("OTHER");
  });
});

describe("technician field steps", () => {
  it("are core edges of the machine and only the two field events", () => {
    expect(isTechnicianFieldEventStep("EN_ROUTE", "ARRIVED")).toBe(true);
    expect(isTechnicianFieldEventStep("ARRIVED", "IN_PROGRESS")).toBe(true);
    expect(isTechnicianFieldEventStep("EN_ROUTE", "IN_PROGRESS")).toBe(false);
    expect(canTransitionJob("EN_ROUTE", "ARRIVED", new Set(["EN_ROUTE>ARRIVED"]))).toBe(true);
    expect(TECHNICIAN_TARGET_STATUSES).toEqual(["EN_ROUTE"]);
  });
});
