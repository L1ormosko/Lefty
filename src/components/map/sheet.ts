/**
 * Where the results sheet comes to rest.
 *
 * The sheet had three heights and one way to reach them: tapping the handle
 * cycled collapsed -> half -> full -> collapsed. That is a control you have to
 * learn, on the one surface where the gesture is obvious - every map app on a
 * phone lets you drag the panel. Dragging needs a rule for where a release
 * lands, and the rule is the part worth testing, so it lives here rather than
 * inside the component.
 */

export type Sheet = "collapsed" | "half" | "full";

export const SHEET_ORDER: Sheet[] = ["collapsed", "half", "full"];

/** Header height when collapsed: the handle plus the result count, nothing else. */
const COLLAPSED_PX = 92;

/**
 * The three resting heights, as a fraction of the viewport.
 *
 * Collapsed is derived from a pixel height rather than fixed as a fraction:
 * it has to fit its own header, and a fraction that works on a tall phone
 * clips the count on a short one.
 */
export function snapPoints(viewport: number): Record<Sheet, number> {
  const safe = Math.max(viewport, 1);
  return {
    collapsed: Math.min(0.25, COLLAPSED_PX / safe),
    half: 0.52,
    full: 0.88,
  };
}

export function clampFraction(fraction: number, viewport: number): number {
  const points = snapPoints(viewport);
  return Math.min(points.full, Math.max(points.collapsed, fraction));
}

/**
 * How far ahead a flick is credited, in seconds.
 *
 * Without it, a fast upward flick that happens to release just below the half
 * point drops back to collapsed - the sheet ignoring an unmistakable gesture,
 * which reads as the drag not working at all.
 */
const PROJECTION_SECONDS = 0.15;

/**
 * Where a release lands.
 *
 * @param fraction  sheet height at release, as a fraction of the viewport
 * @param velocity  fractions of the viewport per second; positive = growing
 */
export function snapTo(fraction: number, velocity: number, viewport: number): Sheet {
  const points = snapPoints(viewport);
  const projected = fraction + velocity * PROJECTION_SECONDS;

  let best: Sheet = "collapsed";
  let bestDistance = Infinity;
  for (const state of SHEET_ORDER) {
    const distance = Math.abs(points[state] - projected);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = state;
    }
  }
  return best;
}

/**
 * The next height when the handle is tapped rather than dragged.
 *
 * Tapping still works, and still opens: a tap is what someone does when they
 * have not realised the sheet drags, so it must not be the gesture that hides
 * the results.
 */
export function nextSheet(current: Sheet): Sheet {
  return current === "collapsed" ? "half" : current === "half" ? "full" : "collapsed";
}
