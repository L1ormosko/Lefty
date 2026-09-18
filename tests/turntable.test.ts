import { describe, expect, it } from "vitest";
import { angleLabel, blend, orderFrames, scrub, step, type Frame } from "@/lib/turntable";
import type { Quad } from "@/lib/mockup";

const QUAD: Quad = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.6 },
  { x: 0.2, y: 0.6 },
];

const frame = (id: string, angleDeg: number | null): Frame => ({
  id,
  url: `/api/images/${id}`,
  quad: QUAD,
  angleDeg,
});

const ids = (frames: Frame[]) => frames.map((f) => f.id);

describe("orderFrames", () => {
  it("arranges photographed angles from left to right", () => {
    const out = orderFrames([frame("front", 0), frame("right", 30), frame("left", -30)]);
    expect(ids(out)).toEqual(["left", "front", "right"]);
  });

  it("leaves unlabelled photos exactly where the owner put them", () => {
    // The point of the test: "b" has no angle, so it is neither sorted to an
    // end nor given a guessed one. It stays in slot 1, and only the two frames
    // that do carry an angle swap between their own slots.
    const out = orderFrames([frame("a", 20), frame("b", null), frame("c", -20)]);
    expect(ids(out)).toEqual(["c", "b", "a"]);
  });

  it("is stable for two photos taken from the same angle", () => {
    const out = orderFrames([frame("first", 0), frame("second", 0)]);
    expect(ids(out)).toEqual(["first", "second"]);
  });

  it("changes nothing when no angle was given at all", () => {
    const out = orderFrames([frame("a", null), frame("b", null), frame("c", null)]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });
});

describe("scrub", () => {
  it("moves the viewpoint with the finger", () => {
    // Dragging left (negative dx) advances through the frames.
    expect(scrub(0, -100, 300, 3)).toBeCloseTo(1, 5);
    expect(scrub(1, 100, 300, 3)).toBeCloseTo(0, 5);
  });

  it("stops at the ends instead of wrapping around", () => {
    // A wrap would animate a rotation between two angles that were never
    // photographed from anywhere in between - invention, not a view.
    expect(scrub(0, 400, 300, 3)).toBe(0);
    expect(scrub(2, -400, 300, 3)).toBe(2);
  });

  it("is inert for a single frame", () => {
    expect(scrub(0, -500, 300, 1)).toBe(0);
  });

  it("survives a zero-width panel", () => {
    // Measured before layout, which happens on a first paint.
    expect(scrub(1, -50, 0, 3)).toBe(1);
  });
});

describe("step", () => {
  it("lands on whole frames from anywhere between them", () => {
    expect(step(1.4, 1, 3)).toBe(2);
    expect(step(1.6, -1, 3)).toBe(1);
  });

  it("clamps at both ends", () => {
    expect(step(0, -1, 3)).toBe(0);
    expect(step(2, 1, 3)).toBe(2);
  });
});

describe("blend", () => {
  it("draws one opaque photo at rest", () => {
    expect(blend(1)).toEqual({ index: 1, next: 1, t: 0 });
    expect(blend(0)).toEqual({ index: 0, next: 0, t: 0 });
  });

  it("dissolves towards the next frame mid-drag", () => {
    const mid = blend(1.25);
    expect(mid.index).toBe(1);
    expect(mid.next).toBe(2);
    expect(mid.t).toBeCloseTo(0.25, 5);
  });
});

describe("angleLabel", () => {
  it("says nothing was given rather than assuming the front", () => {
    expect(angleLabel(null)).toBe("unknown");
  });

  it("buckets the three directions", () => {
    expect(angleLabel(-30)).toBe("left");
    expect(angleLabel(0)).toBe("front");
    expect(angleLabel(5)).toBe("front");
    expect(angleLabel(30)).toBe("right");
  });
});
