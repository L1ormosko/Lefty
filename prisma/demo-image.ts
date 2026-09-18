import sharp from "sharp";
import type { AssetType } from "@prisma/client";

/**
 * A placeholder picture for a demo listing.
 *
 * Every seeded asset had no photo at all, which made the whole marketplace
 * read as unfinished. The fix is deliberately NOT a realistic-looking photo of
 * a billboard: inventing an image of a hoarding that does not exist would be
 * fabricating inventory, the one thing this project must never do - visually
 * this time rather than numerically.
 *
 * So these are schematics. Brand-coloured ground, a simple outline in the
 * proportions of the asset type, and the words "תמונת הדגמה" rendered into the
 * bitmap itself, so the label survives being screenshotted, cropped or
 * exported. Nobody can mistake one for a photograph of a real site. Real
 * assets with no photo keep showing the honest "no image" state.
 */

const INK = "#191d26";
const BRAND = "#1f45d6";
const PAPER = "#eef1f7";

/**
 * The parts of each silhouette that are not the display face: the post a
 * billboard stands on, a shelter's roof and legs, a banner's fixings.
 *
 * Drawn relative to the face rather than at fixed coordinates, so that when
 * the face is restretched to a listing's real proportions the structure still
 * meets it - a post that stops short of the sign it holds up is worse than no
 * post at all.
 */
function structureFor(assetType: AssetType, f: { x: number; y: number; w: number; h: number }): string {
  const cx = f.x + f.w / 2;
  const bottom = f.y + f.h;
  const ground = 86;
  const post = (width: number) =>
    bottom >= ground
      ? ""
      : `<rect x="${cx - width / 2}" y="${bottom}" width="${width}" height="${ground - bottom}"/>`;

  switch (assetType) {
    case "BILLBOARD":
    case "DIGITAL_BILLBOARD":
      return post(8);
    case "BUS_STOP":
      // A roof above the panel, and legs down each side of the shelter.
      return (
        `<rect x="${f.x - 6}" y="${Math.max(6, f.y - 20)}" width="${f.w + 12}" height="6" rx="1"/>` +
        `<rect x="${f.x - 4}" y="${Math.max(12, f.y - 14)}" width="6" height="${ground - Math.max(12, f.y - 14)}"/>` +
        `<rect x="${f.x + f.w - 2}" y="${Math.max(12, f.y - 14)}" width="6" height="${ground - Math.max(12, f.y - 14)}"/>`
      );
    case "STREET_FURNITURE":
      return bottom >= ground
        ? ""
        : `<rect x="${f.x + 6}" y="${bottom}" width="6" height="${ground - bottom}"/>` +
          `<rect x="${f.x + f.w - 12}" y="${bottom}" width="6" height="${ground - bottom}"/>`;
    case "BANNER":
      // Fixings at each end, at the face's own mid-height.
      return (
        `<circle cx="${f.x}" cy="${f.y + f.h / 2}" r="3"/>` +
        `<circle cx="${f.x + f.w}" cy="${f.y + f.h / 2}" r="3"/>`
      );
    default:
      // A wall, a totem and "other" are the face and nothing else.
      return "";
  }
}

/**
 * The display face of each type, in a 0-100 box shared with structureFor().
 *
 * Usually the first rectangle of the silhouette; for a bus stop it is the ad
 * panel rather than the shelter roof. Kept next to the shapes on purpose - the
 * creative preview stands artwork on these coordinates, and a face that has
 * drifted from the drawing would put an ad beside the sign instead of on it.
 *
 * These are the fallback proportions, for a listing that published no
 * dimensions. A listing that did gets its face redrawn to its real shape -
 * see faceFor() - because a 900x300 billboard drawn at 72x34 is a picture of
 * a sign that is not the one being sold.
 */
const FACES: Record<AssetType, { x: number; y: number; w: number; h: number }> = {
  BILLBOARD: { x: 14, y: 26, w: 72, h: 34 },
  DIGITAL_BILLBOARD: { x: 14, y: 24, w: 72, h: 38 },
  WALL: { x: 10, y: 20, w: 80, h: 60 },
  TOTEM: { x: 36, y: 12, w: 28, h: 70 },
  BUS_STOP: { x: 40, y: 46, w: 34, h: 32 },
  STREET_FURNITURE: { x: 24, y: 34, w: 52, h: 40 },
  BANNER: { x: 10, y: 34, w: 80, h: 24 },
  OTHER: { x: 20, y: 28, w: 60, h: 44 },
};

const WIDTH = 1200;
const HEIGHT = 675;

// The transform applied to the silhouette group in the SVG below. Declared
// here so the quad and the drawing are computed from the same two numbers.
const SHAPE_SCALE = 3.8;
const SHAPE_TX = WIDTH / 2 - 190;
const SHAPE_TY = HEIGHT / 2 - 220;

/**
 * The face this listing's picture should be drawn with.
 *
 * Keeps the generic silhouette's centre and area, and restretches it to the
 * listing's real width/height ratio - so a 3:1 billboard is drawn 3:1 and a
 * 0.4:1 totem is drawn tall and narrow, both inside the same frame.
 *
 * Without dimensions it returns the type's generic shape unchanged. Nothing
 * is inferred from the asset type: a "billboard" is not assumed to be 3:1.
 */
export function faceFor(
  assetType: AssetType,
  dimensions?: { widthCm?: number | null; heightCm?: number | null }
): { x: number; y: number; w: number; h: number } {
  const base = FACES[assetType] ?? FACES.OTHER;
  const widthCm = dimensions?.widthCm;
  const heightCm = dimensions?.heightCm;
  if (!widthCm || !heightCm || widthCm <= 0 || heightCm <= 0) return base;

  const ratio = widthCm / heightCm;
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  // Same area as the generic shape, so every type still fills the frame to a
  // similar degree and no listing's picture looks like a mistake.
  const area = base.w * base.h;
  let w = Math.sqrt(area * ratio);
  let h = w / ratio;

  // Keep it inside the drawing box with a small margin, whatever the ratio.
  const maxW = 88;
  const maxH = 80;
  const scale = Math.min(1, maxW / w, maxH / h);
  w *= scale;
  h *= scale;

  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * The angles each demo listing is drawn from.
 *
 * Three views of the same schematic sign, which is what a media owner is asked
 * to photograph: straight on, and from either side. They exist so the
 * turntable preview is reachable from the first listing anybody opens - a
 * feature only one listing can reach is a feature that did not ship, which is
 * the mistake this seed made last time.
 *
 * Still drawings, still stamped "תמונת הדגמה" in the bitmap. Drawing the same
 * schematic from another angle invents no inventory; it is the identical
 * object, projected.
 */
export const DEMO_VIEW_ANGLES = [-28, 0, 28] as const;

/** How far the camera stands from the sign, in the 0-100 drawing box. */
const CAMERA_DISTANCE = 190;

/**
 * The sign's face, seen from `yawDeg` around it.
 *
 * The face is turned about its own vertical centre line and projected with a
 * perspective divide, so the near edge is taller than the far one. That is the
 * whole point: the quad it produces is genuinely projective, the artwork's
 * transform is recomputed from it per angle, and the ad therefore appears
 * fixed to the sign as the view moves. An affine "skew" would slide the ad
 * across the face and read as a sticker.
 *
 * Clockwise from the top-left, which is the order lib/mockup.ts expects.
 */
function projectFace(
  face: { x: number; y: number; w: number; h: number },
  yawDeg: number
): { x: number; y: number }[] {
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  const yaw = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  // u runs along the face, v up and down it; both from its centre.
  const corner = (u: number, v: number) => {
    const depth = u * sin;
    const scale = CAMERA_DISTANCE / (CAMERA_DISTANCE + depth);
    return { x: cx + u * cos * scale, y: cy + v * scale };
  };

  const hw = face.w / 2;
  const hh = face.h / 2;
  return [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
}

/**
 * Where the sign's face sits in a demo photo, as fractions of the image.
 *
 * Computed from the same face and the same angle the picture is drawn with, so
 * the mark cannot drift off the sign in the drawing. A real photograph gets a
 * real quad, marked by an admin looking at it.
 */
export function demoSurfaceQuad(
  assetType: AssetType,
  dimensions?: { widthCm?: number | null; heightCm?: number | null },
  yawDeg = 0
) {
  const face = faceFor(assetType, dimensions);
  const px = (v: number) => (SHAPE_TX + v * SHAPE_SCALE) / WIDTH;
  const py = (v: number) => (SHAPE_TY + v * SHAPE_SCALE) / HEIGHT;
  const round = (n: number) => Number(n.toFixed(4));

  return projectFace(face, yawDeg).map((p) => ({ x: round(px(p.x)), y: round(py(p.y)) }));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function demoImage(params: {
  assetType: AssetType;
  label: string;
  /** The listing's real size, so the drawn sign is the shape being sold. */
  widthCm?: number | null;
  heightCm?: number | null;
  /** Which of DEMO_VIEW_ANGLES this picture is drawn from. */
  yawDeg?: number;
}): Promise<Buffer> {
  const face = faceFor(params.assetType, params);
  const corners = projectFace(face, params.yawDeg ?? 0);
  // The structure - post, legs, roof - is placed under the face as it appears
  // from this angle, so a turned sign does not float beside its own post.
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const seen = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  const shape =
    structureFor(params.assetType, seen) +
    `<polygon points="${corners.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")}"/>`;
  // Long titles would overflow the plate; the badge is the part that matters.
  const label = escapeXml(params.label.slice(0, 44));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  <g stroke="${INK}" stroke-opacity="0.06" stroke-width="1">
    ${Array.from({ length: 15 }, (_, i) => `<line x1="0" y1="${i * 48}" x2="${WIDTH}" y2="${i * 48}"/>`).join("")}
    ${Array.from({ length: 26 }, (_, i) => `<line x1="${i * 48}" y1="0" x2="${i * 48}" y2="${HEIGHT}"/>`).join("")}
  </g>
  <g transform="translate(${SHAPE_TX} ${SHAPE_TY}) scale(${SHAPE_SCALE})" fill="${BRAND}" fill-opacity="0.18"
     stroke="${BRAND}" stroke-width="1.4" stroke-linejoin="round">
    ${shape}
  </g>
  <g transform="translate(${WIDTH / 2} ${HEIGHT - 132})">
    <rect x="-215" y="-34" width="430" height="52" rx="26" fill="${INK}"/>
    <text x="0" y="2" text-anchor="middle" dominant-baseline="middle" direction="rtl"
          font-family="DejaVu Sans, Arial, sans-serif" font-size="26" font-weight="600" fill="#ffffff">
      תמונת הדגמה — לא צילום אמיתי
    </text>
  </g>
  <text x="${WIDTH / 2}" y="${HEIGHT - 60}" text-anchor="middle" direction="rtl"
        font-family="DejaVu Sans, Arial, sans-serif" font-size="24" fill="${INK}" fill-opacity="0.55">
    ${label}
  </text>
</svg>`;

  // Through the same encoder the real upload route uses, so demo rows are
  // stored exactly like uploaded ones - no second code path to keep working.
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}
