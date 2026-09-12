import { describe, expect, it } from "vitest";
import {
  applyHomography,
  isUsableQuad,
  mockupHomography,
  mockupMatrix3d,
  parseQuad,
  type Quad,
} from "@/lib/mockup";

/** A sign seen at an angle: the far edge is shorter than the near one. */
const ANGLED: Quad = [
  { x: 0.2, y: 0.3 },
  { x: 0.8, y: 0.35 },
  { x: 0.8, y: 0.6 },
  { x: 0.2, y: 0.7 },
];

const SQUARE_ON: Quad = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.5 },
  { x: 0.1, y: 0.5 },
];

describe("reading a stored quad", () => {
  it("accepts four points", () => {
    expect(parseQuad(JSON.parse(JSON.stringify(ANGLED)))).toEqual(ANGLED);
  });

  it("rejects anything that is not four points", () => {
    expect(parseQuad(null)).toBeNull();
    expect(parseQuad([])).toBeNull();
    expect(parseQuad(ANGLED.slice(0, 3))).toBeNull();
    expect(parseQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0 }])).toBeNull();
    expect(parseQuad([{ x: "a", y: 0 }, ...ANGLED.slice(1)])).toBeNull();
    expect(parseQuad([{ x: 0, y: NaN }, ...ANGLED.slice(1)])).toBeNull();
  });

  it("allows a corner slightly outside the frame, but not a wild one", () => {
    // A sign cropped by the edge of the photo is real; x = 40 is not a quad.
    expect(parseQuad([{ x: -0.1, y: 0.2 }, ...ANGLED.slice(1)])).not.toBeNull();
    expect(parseQuad([{ x: 40, y: 0.2 }, ...ANGLED.slice(1)])).toBeNull();
  });
});

describe("whether a quad can carry artwork", () => {
  it("accepts an ordinary marked face", () => {
    expect(isUsableQuad(ANGLED)).toBe(true);
    expect(isUsableQuad(SQUARE_ON)).toBe(true);
  });

  it("rejects four points with no area between them", () => {
    const misclick: Quad = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.51, y: 0.51 },
      { x: 0.5, y: 0.5 },
    ];
    expect(isUsableQuad(misclick)).toBe(false);
  });

  it("rejects corners marked out of order", () => {
    // Swapping two corners folds the quad into a bow tie, which renders the
    // artwork mirrored through its own middle.
    const bowtie: Quad = [ANGLED[0], ANGLED[2], ANGLED[1], ANGLED[3]];
    expect(isUsableQuad(bowtie)).toBe(false);
  });
});

describe("the transform itself", () => {
  const photo = { photoWidth: 1000, photoHeight: 600 };
  const creative = { creativeWidth: 400, creativeHeight: 200 };

  it("lands each corner of the artwork on the corner it was marked to", () => {
    // The whole feature in one assertion: the artwork's own four corners,
    // pushed through the matrix, have to arrive at the four marked points.
    const m = mockupHomography({ quad: ANGLED, ...photo, ...creative });
    const corners = [
      [0, 0],
      [creative.creativeWidth, 0],
      [creative.creativeWidth, creative.creativeHeight],
      [0, creative.creativeHeight],
    ];

    corners.forEach(([x, y], i) => {
      const got = applyHomography(m, x, y);
      expect(got.x).toBeCloseTo(ANGLED[i].x * photo.photoWidth, 4);
      expect(got.y).toBeCloseTo(ANGLED[i].y * photo.photoHeight, 4);
    });
  });

  it("works the same for a sign photographed square on", () => {
    // This is the affine case, where the general formula divides by zero and
    // the code takes its other branch. It has to give the same answer.
    const m = mockupHomography({ quad: SQUARE_ON, ...photo, ...creative });
    const topRight = applyHomography(m, creative.creativeWidth, 0);
    expect(topRight.x).toBeCloseTo(SQUARE_ON[1].x * photo.photoWidth, 4);
    expect(topRight.y).toBeCloseTo(SQUARE_ON[1].y * photo.photoHeight, 4);
  });

  it("is genuinely projective, not a skewed rectangle", () => {
    // An affine transform sends the centre of the artwork to the average of
    // the four corners. A projective one does not, and for a sign seen at an
    // angle that difference is the whole reason this is not canvas 2D.
    const m = mockupHomography({ quad: ANGLED, ...photo, ...creative });
    const centre = applyHomography(m, creative.creativeWidth / 2, creative.creativeHeight / 2);
    const averageY =
      (ANGLED.reduce((sum, p) => sum + p.y, 0) / 4) * photo.photoHeight;
    expect(Math.abs(centre.y - averageY)).toBeGreaterThan(0.5);
  });

  it("rescales when the artwork does, landing on the same corners", () => {
    // Two advertisers upload the same design at different resolutions; both
    // must sit exactly on the sign.
    const small = mockupHomography({ quad: ANGLED, ...photo, creativeWidth: 40, creativeHeight: 20 });
    const large = mockupHomography({ quad: ANGLED, ...photo, creativeWidth: 4000, creativeHeight: 2000 });
    const a = applyHomography(small, 40, 20);
    const b = applyHomography(large, 4000, 2000);
    expect(a.x).toBeCloseTo(b.x, 4);
    expect(a.y).toBeCloseTo(b.y, 4);
  });

  it("emits a CSS matrix3d with sixteen values", () => {
    const css = mockupMatrix3d({ quad: ANGLED, ...photo, ...creative });
    expect(css.startsWith("matrix3d(")).toBe(true);
    const values = css.slice("matrix3d(".length, -1).split(",");
    expect(values).toHaveLength(16);
    expect(values.every((v) => Number.isFinite(Number(v)))).toBe(true);
  });

  it("puts the perspective terms in the fourth column, where CSS reads them", () => {
    // Column-major: indices 3 and 7 are the w-row entries. Getting this wrong
    // silently produces an affine result, which is the bug the whole feature
    // exists to avoid.
    const css = mockupMatrix3d({ quad: ANGLED, ...photo, ...creative });
    const v = css.slice("matrix3d(".length, -1).split(",").map(Number);
    const m = mockupHomography({ quad: ANGLED, ...photo, ...creative });
    expect(v[3]).toBeCloseTo(m[6], 6);
    expect(v[7]).toBeCloseTo(m[7], 6);
    expect(v[2]).toBe(0);
    expect(v[10]).toBe(1);
  });
});
