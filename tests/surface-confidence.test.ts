import { describe, expect, it } from "vitest";
import {
  MAX_RATIO_FACTOR,
  MIN_CONFIDENCE,
  impliedRatio,
  ratioPlausible,
  surfaceVerdict,
} from "@/lib/surface-confidence";
import type { Quad } from "@/lib/mockup";

/**
 * The gate between a model's answer and a customer's screen.
 *
 * Marking a sign's face used to be admin-only, and the reason was never that
 * it is hard: a wrong face puts an advertiser's artwork in the wrong place in
 * a picture they may forward to their own client, which misrepresents a real
 * site. Automating the marking is only acceptable with a rule that sends the
 * doubtful ones to a person, so the rule is pinned here rather than trusted.
 */

/** A plain 2:1 rectangle, seen straight on. */
const rect = (w: number, h: number): Quad => [
  { x: 0.2, y: 0.2 },
  { x: 0.2 + w, y: 0.2 },
  { x: 0.2 + w, y: 0.2 + h },
  { x: 0.2, y: 0.2 + h },
];

const wide = rect(0.6, 0.3);
const ai = { source: "ai" as const, confidence: 0.95 };

describe("the shape a quad implies", () => {
  it("reads a straight-on rectangle as its own ratio", () => {
    expect(impliedRatio(rect(0.6, 0.3))).toBeCloseTo(2, 5);
    expect(impliedRatio(rect(0.3, 0.6))).toBeCloseTo(0.5, 5);
  });

  it("is null for a quad with no extent", () => {
    const collapsed: Quad = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ];
    expect(impliedRatio(collapsed)).toBeNull();
  });
});

describe("agreement with the declared dimensions", () => {
  it("passes a quad that matches what the owner measured", () => {
    // 900x300cm is 3:1; a quad seen at an angle reads narrower than that, and
    // that is exactly the case this must not reject.
    expect(ratioPlausible(wide, { widthCm: 900, heightCm: 300 })).toBe(true);
  });

  it("passes anything when no dimensions were declared", () => {
    // "לא צוין" is a real state in this schema. A missing measurement is not
    // evidence against a detection, or the listings with the least
    // information would get the least help.
    expect(ratioPlausible(wide, {})).toBe(true);
    expect(ratioPlausible(wide, { widthCm: 900, heightCm: null })).toBe(true);
  });

  it("rejects a quad that is the wrong shape by a factor", () => {
    // A tall 1:4 sign against a wide 2:1 quad - the signature of the model
    // outlining the wrong object, not of an awkward camera angle.
    expect(ratioPlausible(wide, { widthCm: 100, heightCm: 400 })).toBe(false);
  });

  it("tolerates foreshortening up to the stated factor", () => {
    // The band is wide on purpose; this pins that it really is that wide,
    // since a tight one would reject correct detections of angled signs.
    const declared = { widthCm: 200 * MAX_RATIO_FACTOR, heightCm: 200 };
    expect(ratioPlausible(rect(0.4, 0.4), declared)).toBe(true);
  });
});

describe("the verdict", () => {
  it("shows a confident detection whose shape agrees", () => {
    expect(surfaceVerdict({ quad: wide, ...ai }, { widthCm: 900, heightCm: 300 })).toBe("show");
  });

  it("sends an unsure detection to a person rather than to a customer", () => {
    const unsure = { quad: wide, source: "ai" as const, confidence: MIN_CONFIDENCE - 0.01 };
    expect(surfaceVerdict(unsure, {})).toBe("review");
  });

  it("sends a detection with no stated confidence to review", () => {
    // Silence is not agreement.
    expect(surfaceVerdict({ quad: wide, source: "ai", confidence: null }, {})).toBe("review");
  });

  it("sends a confident detection of the wrong shape to review", () => {
    const asset = { widthCm: 100, heightCm: 400 };
    expect(surfaceVerdict({ quad: wide, ...ai }, asset)).toBe("review");
  });

  it("rejects a bow tie outright instead of queueing it", () => {
    // Corners out of order fold the artwork through itself. There is nothing
    // for a human to confirm here, and queueing it only wastes their time.
    const bowtie: Quad = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.2, y: 0.8 },
      { x: 0.8, y: 0.8 },
    ];
    expect(surfaceVerdict({ quad: bowtie, ...ai }, {})).toBe("reject");
  });

  it("rejects a quad with no area", () => {
    expect(surfaceVerdict({ quad: rect(0.01, 0.01), ...ai }, {})).toBe("reject");
  });

  it("rejects the absence of a detection", () => {
    expect(surfaceVerdict({ quad: null, confidence: null, source: null }, {})).toBe("reject");
  });

  it("shows an admin's marking whatever the numbers say", () => {
    // A person looked at the photograph and clicked the corners. Second-
    // guessing that would make the correction they just made revert itself.
    const asset = { widthCm: 100, heightCm: 400 };
    const marked = { quad: wide, source: "admin" as const, confidence: null };
    expect(surfaceVerdict(marked, asset)).toBe("show");
  });

  it("refuses a quad from nowhere", () => {
    // A row with a quad and no source predates detection, or was written by
    // something that did not say what it was. Neither is a licence to show it.
    expect(surfaceVerdict({ quad: wide, confidence: 1, source: null }, {})).toBe("reject");
  });
});
