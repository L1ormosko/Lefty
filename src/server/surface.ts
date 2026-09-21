import "server-only";

import { z } from "zod";
import { prisma } from "./db";
import { readImage } from "./storage";
import { parseQuad, type Quad } from "@/lib/mockup";
import { surfaceVerdict } from "@/lib/surface-confidence";

/**
 * Finding the face of the sign in the owner's photograph.
 *
 * Why this exists. Everything downstream of a marked face already worked -
 * lib/mockup.ts computes a real projective transform, so an advertiser's
 * artwork converges with the sign's edges instead of sitting on it like a
 * sticker - but the four corners had to be clicked by an admin, one photo at
 * a time. In practice that meant only the demo listings had them, and the
 * preview a real listing offered was no preview at all.
 *
 * The safety contract, which is the same one server/ai.ts works under: the
 * model never sees inventory, never sees prices, and never produces a result
 * anybody acts on directly. It is handed one photograph and the listing's own
 * declared facts, and asked where the sign's face is. Its answer is validated
 * against our geometry, weighed by lib/surface-confidence.ts, and only shown
 * when it is confident and the shape agrees with the dimensions the owner
 * declared. Anything short of that waits for a person.
 *
 * Without ANTHROPIC_API_KEY this does nothing at all and the admin's marking
 * form is unchanged - the same arrangement as the brief parser, and the
 * screen says which marked the face either way.
 *
 * Street View is given to the model as a second picture when one exists, to
 * answer the question the owner's photograph often cannot: which of the signs
 * in frame is the one at this address, and which way does it face. That is a
 * decision of the operator's, taken knowingly - Maps Platform's terms are
 * restrictive about what may be done with their imagery, and the note on that
 * is in docs/OPERATIONS.md rather than buried here. The frame is passed
 * through in memory and never stored.
 */

const MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
/** Longer than the brief parser's: an image costs more to look at. */
const TIMEOUT_MS = 20_000;

export function detectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * What the model is allowed to return.
 *
 * Coordinates are fractions of the image, which is also how surfaceQuad is
 * stored - asking for pixels would mean telling the model the display size,
 * and the same photo is shown at a dozen of them.
 */
const modelSurfaceSchema = z.object({
  found: z.boolean(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  corners: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .length(4)
    .nullable()
    .default(null),
});

/** The listing's own declared facts, which is all the context the model gets. */
export type SurfaceContext = {
  assetType: string;
  address: string | null;
  city: string | null;
  widthCm: number | null;
  heightCm: number | null;
  /** Set when a second, street-level picture is being sent alongside. */
  hasStreetReference?: boolean;
};

function systemPrompt(context: SurfaceContext): string {
  const size =
    context.widthCm && context.heightCm
      ? `The sign is declared as ${context.widthCm}cm wide by ${context.heightCm}cm high.`
      : "The sign's dimensions were not declared.";

  return [
    "You locate the flat advertising face of one outdoor sign in a photograph.",
    "Return ONLY a JSON object, no prose and no code fence.",
    "",
    "Fields:",
    '  found      (boolean) - true only if the sign\'s face is fully identifiable',
    "  corners    (array of exactly 4 {x, y}, or null)",
    "  confidence (number 0..1, or null)",
    "",
    "corners are the four corners OF THE FACE ITSELF - the printable or",
    "displayable rectangle, not the frame, the posts, or the whole structure.",
    "Order them clockwise starting from the face's own top-left, as it would",
    "be read. x and y are fractions of the image width and height, where",
    "(0,0) is the top-left of the photograph and (1,1) the bottom-right.",
    "",
    `This is a ${context.assetType}${context.city ? ` at ${context.address ?? ""} ${context.city}`.trimEnd() : ""}.`,
    size,
    "If several signs appear, choose the one the photograph was taken of: the",
    "largest, most centred, most squarely framed advertising face.",
    "",
    ...(context.hasStreetReference
      ? [
          "You are given TWO pictures. The FIRST is the photograph to answer",
          "about - your corners refer to it and to nothing else. The SECOND is",
          "a street-level view of the same address, looking towards the sign,",
          "for reference only: use it to tell which structure at this address",
          "is the sign, and which way it faces. Never return corners measured",
          "on the second picture.",
          "",
        ]
      : []),
    "confidence is your own honest estimate that these corners are that face.",
    "Report found: false with corners: null when the face is obscured, cut off",
    "at the edge of the frame, or you are not sure which object is the sign.",
    "A refusal is a useful answer here and a guess is not: these corners decide",
    "where a customer's artwork is drawn on a photograph of a real location.",
  ].join("\n");
}

export type DetectionOutcome =
  | { status: "skipped" }
  | { status: "none" }
  | { status: "found"; quad: Quad; confidence: number | null };

/**
 * Ask the model where the face is. Never throws, never blocks a caller's
 * own work - the worst outcome is that nothing was learned about this photo.
 */
export async function detectSurface(
  image: { data: Uint8Array; contentType: string },
  context: SurfaceContext,
  /**
   * A street-level view of the same address, looking towards the sign.
   *
   * Reference only. It tells the model which structure at this address is the
   * sign when the owner's photograph shows several, and which way it faces.
   * The corners still refer to the first picture, and the prompt says so in
   * as many words - a quad measured on the wrong photograph would be a
   * confident answer about a different image.
   */
  reference?: { data: Uint8Array; contentType: string } | null
): Promise<DetectionOutcome> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: "skipped" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: systemPrompt({ ...context, hasStreetReference: !!reference }),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.contentType,
                  data: Buffer.from(image.data).toString("base64"),
                },
              },
              // Second, and labelled as second in the system prompt. Order is
              // the only thing telling the model which picture its answer is
              // about, so it is fixed here rather than left to a caller.
              ...(reference
                ? [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: reference.contentType,
                        data: Buffer.from(reference.data).toString("base64"),
                      },
                    },
                  ]
                : []),
              { type: "text", text: "Where is this sign's face?" },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error("[velto] surface model returned", res.status);
      return { status: "none" };
    }

    const body = await res.json();
    const content = body?.content?.[0]?.text;
    if (typeof content !== "string") return { status: "none" };

    // Bare JSON is asked for; a stray fence should not cost us the answer.
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return { status: "none" };

    const parsed = modelSurfaceSchema.safeParse(JSON.parse(content.slice(start, end + 1)));
    if (!parsed.success || !parsed.data.found || !parsed.data.corners) return { status: "none" };

    // parseQuad is the same gate the admin's hand-typed value goes through:
    // four finite points, not wildly outside the frame. A near miss is not
    // repaired here, it is dropped.
    const quad = parseQuad(parsed.data.corners);
    if (!quad) return { status: "none" };

    return { status: "found", quad, confidence: parsed.data.confidence };
  } catch (err) {
    // A timeout and a network failure are the same to the caller: unknown.
    console.error("[velto] surface detection failed:", err);
    return { status: "none" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect and record, for one stored photograph.
 *
 * Returns what it did, for the backfill script's log. Two rules hold whatever
 * happens:
 *
 * - An admin's marking is never overwritten. They looked at the photograph;
 *   a later detection has nothing to add, and silently reverting a correction
 *   somebody made by hand is the worst behaviour this could have.
 * - surfaceCheckedAt is written even when nothing was found, because "we
 *   looked and there is no usable face here" is a result. Without it the
 *   backfill would ask the same question about the same photo forever.
 */
export async function detectAndStore(imageId: string): Promise<DetectionOutcome> {
  const image = await prisma.mediaAssetImage.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      surfaceSource: true,
      storageKey: true,
      storageProvider: true,
      asset: {
        select: {
          id: true,
          assetType: true,
          address: true,
          city: true,
          widthCm: true,
          heightCm: true,
          latitude: true,
          longitude: true,
        },
      },
    },
  });
  if (!image) return { status: "skipped" };
  if (image.surfaceSource === "admin") return { status: "skipped" };
  if (!detectionEnabled()) return { status: "skipped" };

  const stored = await readImage(imageId);
  if (!stored) return { status: "skipped" };

  /*
   * The street, as a second opinion - except when the picture already is the
   * street.
   *
   * Sending a Street View frame as its own reference would spend a request to
   * show the model the image it is already looking at, and would invite it to
   * answer about "the second picture" when both are the same one.
   */
  const reference =
    image.storageProvider === "streetview" ? null : await streetReference(image.asset);

  const outcome = await detectSurface(
    { data: stored.data, contentType: stored.contentType },
    {
      assetType: image.asset.assetType,
      address: image.asset.address,
      city: image.asset.city,
      widthCm: image.asset.widthCm,
      heightCm: image.asset.heightCm,
    },
    reference
  );
  if (outcome.status === "skipped") return outcome;

  if (outcome.status === "none") {
    await prisma.mediaAssetImage.update({
      where: { id: image.id },
      data: { surfaceCheckedAt: new Date() },
    });
    return outcome;
  }

  /*
   * A quad the rules reject outright is not stored at all.
   *
   * "reject" means the four points do not enclose a face - a collapsed quad
   * or corners out of order. There is nothing for a person to confirm and
   * nothing to show, so storing it would only put a row in the review queue
   * that wastes the reviewer's time. "review" is different and is stored:
   * that one a person can look at and correct.
   */
  const verdict = surfaceVerdict(
    { quad: outcome.quad, confidence: outcome.confidence, source: "ai" },
    image.asset
  );
  if (verdict === "reject") {
    await prisma.mediaAssetImage.update({
      where: { id: image.id },
      data: { surfaceCheckedAt: new Date() },
    });
    return { status: "none" };
  }

  await prisma.mediaAssetImage.update({
    where: { id: image.id },
    data: {
      surfaceQuad: outcome.quad,
      surfaceSource: "ai",
      surfaceConfidence: outcome.confidence,
      surfaceCheckedAt: new Date(),
    },
  });
  return outcome;
}

/**
 * A street-level frame of the same address, or null.
 *
 * Fetched fresh and held only for the length of this call - the same rule the
 * streetview storage provider works under. Every failure returns null and the
 * detection simply proceeds on the owner's photograph alone, which is what it
 * did before this existed.
 */
async function streetReference(asset: {
  id: string;
  latitude: number;
  longitude: number;
}): Promise<{ data: Uint8Array; contentType: string } | null> {
  try {
    const { lookupPano } = await import("./streetview");
    const view = await lookupPano({ lat: asset.latitude, lng: asset.longitude });
    if (!view) return null;

    const { streetViewStorage, streetViewKeyFor } = await import("./storage/streetview");
    const frame = await streetViewStorage.get(streetViewKeyFor(view));
    return frame ? { data: frame.data, contentType: frame.contentType } : null;
  } catch (err) {
    // A reference that could not be fetched is a reference we do without.
    console.error("[velto] street reference failed:", err);
    return null;
  }
}
