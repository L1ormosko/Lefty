import { describe, expect, it } from "vitest";
import { clampFraction, nextSheet, snapPoints, snapTo } from "@/components/map/sheet";

/** A Pixel 7, which is what the mobile e2e project emulates. */
const VIEWPORT = 915;

describe("where the sheet rests", () => {
  it("keeps the collapsed header visible on a short screen", () => {
    // A flat fraction would clip the result count on a small phone.
    const short = snapPoints(568);
    expect(short.collapsed * 568).toBeGreaterThanOrEqual(92);
    const tall = snapPoints(1024);
    expect(tall.collapsed * 1024).toBeCloseTo(92, 0);
  });

  it("never lets the sheet swallow the map or vanish entirely", () => {
    const points = snapPoints(VIEWPORT);
    expect(clampFraction(2, VIEWPORT)).toBe(points.full);
    expect(clampFraction(-1, VIEWPORT)).toBe(points.collapsed);
  });
});

describe("releasing a drag", () => {
  it("settles on the nearest height when released slowly", () => {
    expect(snapTo(0.5, 0, VIEWPORT)).toBe("half");
    expect(snapTo(0.8, 0, VIEWPORT)).toBe("full");
    expect(snapTo(0.12, 0, VIEWPORT)).toBe("collapsed");
  });

  it("credits a flick, so a fast gesture is not undone by where the finger left", () => {
    // Velocities are fractions of the viewport per second: on a Pixel 7, 1.0
    // is about 900px/s - a deliberate drag - and 3.5 is a hard flick.
    //
    // Released just below half, but still moving up: dropping back to collapsed
    // here is the bug that makes a drag feel broken.
    expect(snapTo(0.42, 1, VIEWPORT)).toBe("half");
    expect(snapTo(0.42, 3.5, VIEWPORT)).toBe("full");
  });

  it("credits a flick downwards too", () => {
    expect(snapTo(0.55, -3, VIEWPORT)).toBe("collapsed");
  });

  it("ignores a flick that is only a tremor", () => {
    expect(snapTo(0.85, 0.3, VIEWPORT)).toBe("full");
    expect(snapTo(0.12, -0.3, VIEWPORT)).toBe("collapsed");
  });
});

describe("tapping the handle", () => {
  it("opens the sheet rather than hiding it", () => {
    // Someone who has not noticed the sheet drags will tap it, and a tap that
    // collapses the results is the product hiding its own inventory.
    expect(nextSheet("collapsed")).toBe("half");
    expect(nextSheet("half")).toBe("full");
    expect(nextSheet("full")).toBe("collapsed");
  });
});
