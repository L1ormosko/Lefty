/**
 * Putting an advertiser's artwork onto a photograph of a real billboard.
 *
 * A billboard in a street photo is a rectangle seen at an angle, so fitting
 * artwork to it needs a projective transform - parallel lines in the artwork
 * must converge the way the sign's edges converge. Canvas 2D cannot do this:
 * `setTransform` takes six numbers and is affine, which keeps parallels
 * parallel and produces a skewed parallelogram that reads as a sticker.
 *
 * CSS `matrix3d` can, because it is a full 4x4 homogeneous matrix - the
 * browser divides by w when it rasterises. So the whole feature costs one
 * CSS string and no stored bytes: no 3D model, no rendered composite, nothing
 * uploaded. The admin marks four corners once; every advertiser's preview is
 * computed in their own browser from a file that never leaves it.
 *
 * What this is NOT is stated on the screen and bears repeating here: it is a
 * flat overlay. It does not relight the artwork, wrap it around a curve, or
 * respect anything passing in front of the sign. It is a positioning aid, and
 * the label calls it one.
 */

export type Point = { x: number; y: number };

/**
 * The four corners of the sign's face, clockwise from its top-left, as
 * fractions of the photo's width and height.
 *
 * Normalised rather than pixels because the same photo is displayed at a
 * dozen sizes - a phone, a desktop panel, a print preview - and a quad in
 * pixels would be right at exactly one of them.
 */
export type Quad = [Point, Point, Point, Point];

/** A stored value from the database, which is `Json` and therefore unknown. */
export function parseQuad(value: unknown): Quad | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const points: Point[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const { x, y } = raw as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Outside the photo is not a mistake worth guessing at - a corner can sit
    // a little off-frame when the sign is cropped - but wildly outside means
    // the value is not a quad at all.
    if (x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5) return null;
    points.push({ x, y });
  }
  return points as Quad;
}

/**
 * Twice the signed area of the quad, by the shoelace formula.
 *
 * Sign tells winding; magnitude tells whether there is a face here at all.
 */
function signedArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/**
 * Is this quad something artwork can actually be placed on?
 *
 * Rejects the two ways marking corners goes wrong: four points on top of each
 * other (a mis-click, no area), and corners given out of order, which folds
 * the quad into a bow tie and renders the artwork inside out.
 */
export function isUsableQuad(quad: Quad): boolean {
  if (Math.abs(signedArea(quad)) < 0.002) return false;

  // A bow tie has one interior "corner" that turns the opposite way to the
  // others. A convex quad's cross products all share a sign.
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross > 1e-9) positive++;
    if (cross < -1e-9) negative++;
  }
  return positive === 0 || negative === 0;
}

/**
 * The 3x3 homography taking the unit square to four destination points.
 *
 * Row-major [a, b, c, d, e, f, g, h, 1], mapping
 *   (0,0) -> p0   (1,0) -> p1   (1,1) -> p2   (0,1) -> p3
 *
 * The closed form is the standard one for a unit-square-to-quad map; the
 * degenerate branch is when the destination is already a parallelogram, where
 * the projective terms are zero and the general formula divides by zero.
 */
function unitSquareTo(p0: Point, p1: Point, p2: Point, p3: Point): number[] {
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    // A parallelogram: the transform is affine, and the general formula's
    // denominator would be the area of a triangle that has collapsed.
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }

  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;

  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

/** Where a homography sends one point. Exported for tests, and for tests only. */
export function applyHomography(m: number[], x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8];
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
  };
}

export type MockupInput = {
  quad: Quad;
  /** Displayed size of the photograph, in CSS pixels. */
  photoWidth: number;
  photoHeight: number;
  /** Natural size of the advertiser's artwork, in pixels. */
  creativeWidth: number;
  creativeHeight: number;
};

/**
 * The homography for a creative of a given size, in the photo's pixel space.
 *
 * The artwork is laid out at its own natural size with its top-left at the
 * origin, so the transform has to undo that size before mapping the unit
 * square - hence the division by the creative's width and height.
 */
export function mockupHomography(input: MockupInput): number[] {
  const { quad, photoWidth, photoHeight, creativeWidth, creativeHeight } = input;
  const px = quad.map((p) => ({ x: p.x * photoWidth, y: p.y * photoHeight })) as Quad;
  const m = unitSquareTo(px[0], px[1], px[2], px[3]);

  const sw = creativeWidth || 1;
  const sh = creativeHeight || 1;
  return [m[0] / sw, m[1] / sh, m[2], m[3] / sw, m[4] / sh, m[5], m[6] / sw, m[7] / sh, m[8]];
}

/**
 * The same transform as a CSS value.
 *
 * matrix3d() is column-major and 4x4, so the 3x3 homography's third row - the
 * one carrying the perspective divide - becomes the fourth column, and z is
 * left as identity.
 */
export function mockupMatrix3d(input: MockupInput): string {
  const [a, b, c, d, e, f, g, h, i] = mockupHomography(input);
  const values = [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i];
  return `matrix3d(${values.map((n) => Number(n.toFixed(6))).join(", ")})`;
}
