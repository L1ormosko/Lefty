/**
 * Several photographs of one sign, presented as one object.
 *
 * The request behind this was "a feeling of three dimensions, not a 360 model":
 * a few real angles of the same sign, with the advertiser's artwork sitting
 * correctly on each, so the preview reads as an object in a street rather than
 * a picture with something pasted on it.
 *
 * What actually produces that feeling is not the photographs - it is that the
 * artwork's perspective changes with them. Each photo has its own marked face
 * (MediaAssetImage.surfaceQuad), so lib/mockup.ts recomputes the homography per
 * frame and the ad appears fixed to the sign. Scrubbing between two such frames
 * is parallax, and parallax is what the eye reads as depth.
 *
 * Everything here is deliberately pure: this project runs vitest under node
 * with no jsdom, so logic that lives in a component cannot be tested at all.
 *
 * What this is NOT: a 3D model, an interpolation between angles, or a rotation.
 * Only photographed angles are shown, and only in the order they were taken
 * around the sign. Nothing between two frames is invented - the crossfade is a
 * dissolve, not a synthesised in-between view.
 */

import type { Quad } from "@/lib/mockup";

/** One photographed angle of the sign, with its face already marked. */
export type Frame = {
  id: string;
  url: string;
  quad: Quad;
  /**
   * Where the camera stood, in degrees around the sign's face: 0 is straight
   * on, negative is to its left, positive to its right.
   *
   * Null is a real and common state - an owner who uploaded photos without
   * saying where they stood - and it is never guessed at. See orderFrames.
   */
  angleDeg: number | null;
};

/**
 * Display order: by angle where it is known, otherwise upload order.
 *
 * Frames with no angle keep their original positions rather than being sorted
 * to one end or assigned a made-up angle; only the frames that carry an angle
 * are arranged among themselves. So an owner who labelled two of three photos
 * gets those two in the right order and the third exactly where they put it,
 * which is the honest reading of what they told us.
 */
export function orderFrames(frames: Frame[]): Frame[] {
  const slots: number[] = [];
  const angled: Frame[] = [];
  frames.forEach((frame, i) => {
    if (frame.angleDeg == null) return;
    slots.push(i);
    angled.push(frame);
  });

  // Stable: two photos taken at the same angle keep their upload order.
  const sorted = angled
    .map((frame, i) => ({ frame, i }))
    .sort((a, b) => a.frame.angleDeg! - b.frame.angleDeg! || a.i - b.i)
    .map((entry) => entry.frame);

  const out = frames.slice();
  slots.forEach((slot, i) => {
    out[slot] = sorted[i];
  });
  return out;
}

/**
 * How far a drag moves the turntable, as a fraction of the panel's width.
 *
 * A full sweep across the photo steps through roughly three frames, which is
 * about the number of angles an owner realistically photographs. Slower than
 * that feels stuck; faster and a small hand movement skips the middle view.
 */
const FRAMES_PER_SWEEP = 3;

/**
 * A new position on the turntable after dragging `dx` pixels.
 *
 * Positions are continuous - 1.4 is "between the second and third frames" -
 * because the crossfade needs the fraction, not only the nearest frame.
 *
 * Clamped at both ends, never wrapped. Two photographs taken from either side
 * of a sign are not a loop: jumping from the last angle back to the first would
 * animate a rotation nobody photographed, which is the same class of invention
 * as a made-up price. The drag simply stops, and the last frame stays.
 *
 * Direction: this is a right-to-left interface, but the gesture is physical
 * rather than textual - dragging left moves the viewpoint rightwards through
 * the frames, the way pushing a turntable does. Mirroring it for RTL would make
 * the photo move opposite to the finger.
 */
export function scrub(pos: number, dx: number, width: number, count: number): number {
  const last = Math.max(0, count - 1);
  if (!Number.isFinite(pos) || !Number.isFinite(dx) || !(width > 0)) return clamp(pos, last);
  return clamp(pos - (dx / width) * FRAMES_PER_SWEEP, last);
}

function clamp(pos: number, last: number): number {
  if (!Number.isFinite(pos)) return 0;
  return Math.min(last, Math.max(0, pos));
}

/** Step exactly one frame - the keyboard's version of a drag. */
export function step(pos: number, delta: number, count: number): number {
  return clamp(Math.round(pos) + delta, Math.max(0, count - 1));
}

/**
 * Which frame is showing, which one is dissolving in, and how far along.
 *
 * At rest `t` is exactly 0 and `next` is the same frame as `index`, so a
 * settled turntable draws one fully opaque photograph. Half-transparent frames
 * at rest would make every sign look like a double exposure.
 */
export function blend(pos: number): { index: number; next: number; t: number } {
  const index = Math.floor(pos);
  const t = pos - index;
  // Exactly on a frame: no second layer at all.
  if (t < 1e-6) return { index, next: index, t: 0 };
  return { index, next: index + 1, t };
}

/**
 * What to call an angle on screen.
 *
 * The buckets are coarse on purpose. An owner standing in a street does not
 * know they were at 23 degrees, and printing "23°" would dress a rough note up
 * as a measurement.
 */
export function angleLabel(angleDeg: number | null): "left" | "front" | "right" | "unknown" {
  if (angleDeg == null || !Number.isFinite(angleDeg)) return "unknown";
  if (angleDeg <= -10) return "left";
  if (angleDeg >= 10) return "right";
  return "front";
}
