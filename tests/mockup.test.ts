import { describe, expect, it } from "vitest";
import {
  applyHomography,
  faceRatio,
  fitRect,
  isUsableQuad,
  ratioMatches,
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

describe("fitting the artwork to the sign's real proportions", () => {
  const photo = { photoWidth: 1000, photoHeight: 600 };
  /**
   * A 3:1 billboard seen square on: 600x200 screen pixels, which is 3:1.
   *
   * The quad's on-screen shape has to agree with the declared dimensions for
   * a face-on photo, or the fixture is describing a sign that cannot exist -
   * and then nothing rendered from it means anything.
   */
  const WIDE: Quad = [
    { x: 0.1, y: 0.3 },
    { x: 0.7, y: 0.3 },
    { x: 0.7, y: 0.6333 },
    { x: 0.1, y: 0.6333 },
  ];

  it("reads the ratio from the listing, and refuses to invent one", () => {
    expect(faceRatio({ widthCm: 900, heightCm: 300 })).toBe(3);
    expect(faceRatio({ widthCm: 120, heightCm: 300 })).toBe(0.4);
    expect(faceRatio({ widthCm: null, heightCm: 300 })).toBeNull();
    expect(faceRatio({ widthCm: 900, heightCm: null })).toBeNull();
    expect(faceRatio({ widthCm: 0, heightCm: 300 })).toBeNull();
  });

  it("puts bars at the sides of a square file on a wide sign", () => {
    // The bug this replaces: a 1:1 file on a 3:1 billboard rendered three
    // times too wide - an advertiser shown an ad that will never exist.
    //
    // A square fitted into a sign three times wider than it is tall keeps the
    // full height and takes a third of the width, so the bars are vertical.
    const [u0, v0, u1, v1] = fitRect(3, 1);
    expect(v0).toBe(0);
    expect(v1).toBe(1);
    expect(u1 - u0).toBeCloseTo(1 / 3, 6);
    expect(u0).toBeCloseTo(1 / 3, 6);
  });

  it("puts bars above and below a wide file on a tall sign", () => {
    // A 3:1 banner file on a 0.4:1 totem: full width, a thin band of height.
    const [u0, v0, u1, v1] = fitRect(0.4, 3);
    expect(u0).toBe(0);
    expect(u1).toBe(1);
    expect(v1 - v0).toBeCloseTo(0.4 / 3, 6);
  });

  it("fills the face exactly when the proportions agree", () => {
    expect(fitRect(3, 3)).toEqual([0, 0, 1, 1]);
  });

  it("fills the face when the sign has no published dimensions", () => {
    // Honest fallback: without the physical size there is no way to know the
    // face's shape. The panel says so rather than the code guessing.
    expect(fitRect(null, 1)).toEqual([0, 0, 1, 1]);
    expect(ratioMatches(null, 1)).toBe(false);
  });

  it("keeps the artwork inside the face rather than overflowing it", () => {
    // A square file on the wide sign: the rendered corners must sit within
    // the marked face, not spill over the frame around it.
    const m = mockupHomography({
      quad: WIDE,
      ...photo,
      creativeWidth: 500,
      creativeHeight: 500,
      faceRatio: 3,
    });
    const corners = [
      applyHomography(m, 0, 0),
      applyHomography(m, 500, 0),
      applyHomography(m, 500, 500),
      applyHomography(m, 0, 500),
    ];
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(WIDE[0].x * photo.photoWidth - 0.01);
      expect(c.x).toBeLessThanOrEqual(WIDE[1].x * photo.photoWidth + 0.01);
      expect(c.y).toBeGreaterThanOrEqual(WIDE[0].y * photo.photoHeight - 0.01);
      expect(c.y).toBeLessThanOrEqual(WIDE[2].y * photo.photoHeight + 0.01);
    }
  });

  it("renders a square file square, not stretched to the sign", () => {
    // The whole point, measured: equal sides in, equal sides out.
    const m = mockupHomography({
      quad: WIDE,
      ...photo,
      creativeWidth: 500,
      creativeHeight: 500,
      faceRatio: 3,
    });
    const topLeft = applyHomography(m, 0, 0);
    const topRight = applyHomography(m, 500, 0);
    const bottomLeft = applyHomography(m, 0, 500);
    const width = Math.abs(topRight.x - topLeft.x);
    const height = Math.abs(bottomLeft.y - topLeft.y);
    expect(width / height).toBeCloseTo(1, 3);
  });

  it("still stretches when dimensions are unknown, which is the documented fallback", () => {
    const m = mockupHomography({
      quad: WIDE,
      ...photo,
      creativeWidth: 500,
      creativeHeight: 500,
      faceRatio: null,
    });
    const topLeft = applyHomography(m, 0, 0);
    const topRight = applyHomography(m, 500, 0);
    const bottomLeft = applyHomography(m, 0, 500);
    const ratio =
      Math.abs(topRight.x - topLeft.x) / Math.abs(bottomLeft.y - topLeft.y);
    // Filled to the face, so the square comes out at the face's own shape.
    expect(ratio).toBeCloseTo(3, 1);
  });

  it("does not nag about a difference nobody can see", () => {
    expect(ratioMatches(3, 3.01)).toBe(true);
    expect(ratioMatches(3, 2.5)).toBe(false);
  });
});
