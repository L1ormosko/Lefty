import { describe, expect, it } from "vitest";
import { bearingDegrees, metresBetween, suggestedFov } from "@/lib/geo";

/**
 * The arithmetic that points a camera at a sign.
 *
 * This exists because of a bug with a plain symptom: the listing page embedded
 * Street View with the sign's coordinates and nothing else, so Google chose
 * both the panorama and the direction, and on a corner plot it showed a
 * different street. Everything about the fix rests on this bearing being
 * right, and a heading that is wrong by ninety degrees looks exactly like the
 * bug it is supposed to fix.
 */

// A point in Be'er Sheva, the pilot market, so the latitude in these tests is
// the latitude the product actually runs at.
const BEER_SHEVA = { lat: 31.2518, lng: 34.7913 };

describe("bearing", () => {
  it("reads due north as 0 and due south as 180", () => {
    expect(bearingDegrees(BEER_SHEVA, { ...BEER_SHEVA, lat: 31.2618 })).toBeCloseTo(0, 1);
    expect(bearingDegrees(BEER_SHEVA, { ...BEER_SHEVA, lat: 31.2418 })).toBeCloseTo(180, 1);
  });

  it("reads due east as 90 and due west as 270", () => {
    expect(bearingDegrees(BEER_SHEVA, { ...BEER_SHEVA, lng: 34.8013 })).toBeCloseTo(90, 1);
    expect(bearingDegrees(BEER_SHEVA, { ...BEER_SHEVA, lng: 34.7813 })).toBeCloseTo(270, 1);
  });

  it("never returns a negative angle", () => {
    // Street View's heading is 0..360. A -90 is silently accepted by the API
    // and points somewhere else entirely.
    const west = bearingDegrees(BEER_SHEVA, { lat: 31.2518, lng: 34.78 });
    expect(west).toBeGreaterThanOrEqual(0);
    expect(west).toBeLessThan(360);
  });

  it("accounts for longitude being shorter than latitude here", () => {
    /*
     * The test that earns this file.
     *
     * At 31°N a degree of longitude is about 0.855 of a degree of latitude,
     * so a point offset equally in both does NOT sit at 45°. Treating the
     * two as interchangeable - the obvious planar shortcut - gives exactly
     * 45 and frames the building next door.
     */
    const equalOffset = { lat: BEER_SHEVA.lat + 0.001, lng: BEER_SHEVA.lng + 0.001 };
    const angle = bearingDegrees(BEER_SHEVA, equalOffset);
    expect(angle).toBeGreaterThan(40);
    expect(angle).toBeLessThan(41);
  });

  it("is antisymmetric, as a bearing has to be", () => {
    const other = { lat: 31.2531, lng: 34.7929 };
    const there = bearingDegrees(BEER_SHEVA, other);
    const back = bearingDegrees(other, BEER_SHEVA);
    // Looking back should be looking the opposite way. Exactly 180 only along
    // a meridian - the meridians converge - but over a street's length the
    // difference is thousandths of a degree.
    const apart = (((there - back) % 360) + 360) % 360;
    expect(apart).toBeGreaterThan(179.9);
    expect(apart).toBeLessThan(180.1);
  });
});

describe("distance", () => {
  it("measures a short hop in metres", () => {
    // 0.001° of latitude is about 111m anywhere on earth.
    const north = { ...BEER_SHEVA, lat: BEER_SHEVA.lat + 0.001 };
    expect(metresBetween(BEER_SHEVA, north)).toBeGreaterThan(105);
    expect(metresBetween(BEER_SHEVA, north)).toBeLessThan(117);
  });

  it("is zero for the same point, not NaN", () => {
    // The haversine's arcsine argument can drift above 1 through floating
    // point and produce NaN, which would silently disqualify every panorama.
    expect(metresBetween(BEER_SHEVA, { ...BEER_SHEVA })).toBe(0);
  });
});

describe("how wide a view to ask for", () => {
  it("narrows as the sign gets further away", () => {
    const near = suggestedFov(5);
    const mid = suggestedFov(40);
    const far = suggestedFov(100);
    // A sign across a junction fills a small part of a wide frame; a narrower
    // field is the difference between a photograph of a sign and one of a
    // street with a sign somewhere in it.
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });

  it("stays inside what the Street View API accepts", () => {
    for (const d of [0, 1, 15, 45, 79, 1000]) {
      expect(suggestedFov(d)).toBeGreaterThanOrEqual(10);
      expect(suggestedFov(d)).toBeLessThanOrEqual(120);
    }
  });
});
