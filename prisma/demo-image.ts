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

/** Rough silhouette per type, in a 0-100 box, so the shapes are distinguishable. */
const SHAPES: Record<AssetType, string> = {
  BILLBOARD: '<rect x="14" y="26" width="72" height="34" rx="1.5"/><rect x="46" y="60" width="8" height="26"/>',
  DIGITAL_BILLBOARD:
    '<rect x="14" y="24" width="72" height="38" rx="3"/><rect x="46" y="62" width="8" height="24"/>',
  WALL: '<rect x="10" y="20" width="80" height="60" rx="1"/>',
  TOTEM: '<rect x="36" y="12" width="28" height="70" rx="4"/>',
  BUS_STOP: '<rect x="16" y="26" width="68" height="6" rx="1"/><rect x="18" y="32" width="6" height="46"/><rect x="76" y="32" width="6" height="46"/><rect x="40" y="46" width="34" height="32" rx="1"/>',
  STREET_FURNITURE: '<rect x="24" y="34" width="52" height="40" rx="3"/><rect x="30" y="74" width="6" height="10"/><rect x="64" y="74" width="6" height="10"/>',
  BANNER: '<rect x="10" y="34" width="80" height="24" rx="2"/><circle cx="10" cy="46" r="3"/><circle cx="90" cy="46" r="3"/>',
  OTHER: '<rect x="20" y="28" width="60" height="44" rx="2"/>',
};

const WIDTH = 1200;
const HEIGHT = 675;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function demoImage(params: { assetType: AssetType; label: string }): Promise<Buffer> {
  const shape = SHAPES[params.assetType] ?? SHAPES.OTHER;
  // Long titles would overflow the plate; the badge is the part that matters.
  const label = escapeXml(params.label.slice(0, 44));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  <g stroke="${INK}" stroke-opacity="0.06" stroke-width="1">
    ${Array.from({ length: 15 }, (_, i) => `<line x1="0" y1="${i * 48}" x2="${WIDTH}" y2="${i * 48}"/>`).join("")}
    ${Array.from({ length: 26 }, (_, i) => `<line x1="${i * 48}" y1="0" x2="${i * 48}" y2="${HEIGHT}"/>`).join("")}
  </g>
  <g transform="translate(${WIDTH / 2 - 190} ${HEIGHT / 2 - 220}) scale(3.8)" fill="${BRAND}" fill-opacity="0.18"
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
