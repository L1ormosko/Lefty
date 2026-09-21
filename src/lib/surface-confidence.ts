/**
 * Whether a machine-marked sign face is good enough to put in front of a
 * customer.
 *
 * The face of a sign decides where an advertiser's artwork lands in a preview
 * they may well forward to their own client. A wrong one produces a picture
 * that misrepresents a real site - the same class of harm as a wrong price,
 * which is why marking was an admin-only job in the first place (see
 * setImageQuadAction). Automating it is only acceptable with something
 * standing between the model's answer and the screen. This is that something.
 *
 * Deliberately pure and in lib/, for two reasons: it is the kind of rule that
 * has to be tested exhaustively rather than eyeballed, and the listing page
 * and the admin queue must answer this question identically. Two callers with
 * two copies of a threshold is how a quad ends up hidden in one place and
 * shown in the other.
 */
import { faceRatio, isUsableQuad, type Quad } from "./mockup";

/**
 * How sure the model has to be before its answer is shown without a human.
 *
 * Not tuned against a dataset, because there is no dataset - it is a starting
 * position chosen to send the doubtful cases to a person rather than to a
 * customer. It is stated once, here, and it is meant to be moved once there
 * are real detections to look at.
 */
export const MIN_CONFIDENCE = 0.8;

/**
 * How far the quad's implied shape may differ from the sign's declared shape.
 *
 * Wide on purpose. See impliedRatio: the number it guards is a rough estimate
 * from a foreshortened quad, not a measurement, and a tight band here would
 * reject correct detections of signs photographed from an angle - which is
 * most of them.
 */
export const MAX_RATIO_FACTOR = 2.5;

export type Detection = {
  quad: Quad | null;
  /** What the model said about its own answer, 0..1. Null when unknown. */
  confidence: number | null;
  source: "ai" | "admin" | null;
};

export type SurfaceVerdict =
  /** Show it. An admin marked it, or the model was sure and the shape agrees. */
  | "show"
  /** Keep it, show nobody, put it in the queue for a human to confirm. */
  | "review"
  /** Not a face at all. Nothing to confirm and nothing to show. */
  | "reject";

/**
 * The quad's width/height ratio as it appears in the photograph.
 *
 * An estimate, and the honest description of it is "mean opposite edge over
 * mean opposite edge". A sign photographed at an angle is foreshortened, so
 * this systematically understates the real width of an angled face - it
 * cannot be otherwise without knowing the camera. Recovering the true ratio
 * needs the full rectification, and a check that has to be right to two
 * decimal places is the wrong tool for catching "the model outlined a window
 * instead of the billboard".
 *
 * So it is used only against MAX_RATIO_FACTOR, to catch answers that are the
 * wrong shape by a factor, never to judge a near miss.
 */
export function impliedRatio(quad: Quad): number | null {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);

  // Clockwise from the top-left: 0-1 is the top edge, 2-3 the bottom,
  // 1-2 the right side, 3-0 the left.
  const width = (dist(quad[0], quad[1]) + dist(quad[2], quad[3])) / 2;
  const height = (dist(quad[1], quad[2]) + dist(quad[3], quad[0])) / 2;
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}

/**
 * Does the detected shape agree with the dimensions the owner declared?
 *
 * True when there is nothing to disagree with. An undeclared dimension is
 * "לא צוין" everywhere else in this product, and absence of a measurement is
 * not evidence against a detection - treating it as such would mean the
 * listings with the least information also get the least help.
 */
export function ratioPlausible(
  quad: Quad,
  asset: { widthCm?: number | null; heightCm?: number | null }
): boolean {
  const declared = faceRatio(asset);
  if (declared == null) return true;
  const seen = impliedRatio(quad);
  if (seen == null) return false;

  const factor = seen > declared ? seen / declared : declared / seen;
  return factor <= MAX_RATIO_FACTOR;
}

/**
 * The one decision, made in one place.
 *
 * Order matters: geometry first, because a bow tie or a collapsed quad is not
 * a doubtful detection but a non-answer, and putting it in a human queue only
 * wastes the human's time. Confidence and shape come after, and both of them
 * mean "ask someone", never "discard".
 */
export function surfaceVerdict(
  detection: Detection,
  asset: { widthCm?: number | null; heightCm?: number | null }
): SurfaceVerdict {
  const { quad, confidence, source } = detection;
  if (!quad) return "reject";
  if (!isUsableQuad(quad)) return "reject";

  // A person looked at the photograph and clicked the corners. There is
  // nothing a threshold can add to that, and second-guessing it would make
  // the correction the admin just made revert itself.
  if (source === "admin") return "show";
  if (source !== "ai") return "reject";

  if (confidence == null || confidence < MIN_CONFIDENCE) return "review";
  if (!ratioPlausible(quad, asset)) return "review";
  return "show";
}

/** Convenience for the render path, which only cares about the one case. */
export function isShowable(
  detection: Detection,
  asset: { widthCm?: number | null; heightCm?: number | null }
): boolean {
  return surfaceVerdict(detection, asset) === "show";
}
