/**
 * Where one employee's metric value sits among the comparable values of colleagues (spec 10.4 "strengths / development
 * opportunities"). Pure functions, no I/O.
 *
 * Rules (DECISIONS.md "Phase 5 Task 6"):
 * - A position is per ONE definition version, ONE period and ONE breakdown (job type / category): never across
 *   dimensions, never a combined score.
 * - Only values with enough data (`sampleSize >= minSample`) and at least one opportunity take part, the subject's included.
 * - Fewer than `MIN_PEERS_FOR_POSITION` comparable employees (the subject included) = no position: a quartile of three
 *   people says nothing, and it would make a single colleague identifiable.
 * - Rates are compared exactly (cross-multiplication of integers), never as floats.
 * - "Better" is higher, except for kinds where lower is better (REPEAT_VISIT_RATE).
 * - Quartile 1 is the best quarter. Ties count half (mid-rank), so a group where everyone is equal is "typical" for all,
 *   not a strength for all.
 */

export const MIN_PEERS_FOR_POSITION = 4;

/** Kinds where a LOW value is good (a repeat visit is a visit that did not fix the problem). */
const LOWER_IS_BETTER_KINDS: ReadonlySet<string> = new Set(["REPEAT_VISIT_RATE"]);
export const lowerIsBetter = (kind: string): boolean => LOWER_IS_BETTER_KINDS.has(kind);

export interface ComparableValue {
  employeeId: string;
  numerator: number;
  denominator: number;
  enoughData: boolean;
}

export type PositionStatus = "POSITIONED" | "NOT_ENOUGH_DATA" | "NOT_ENOUGH_PEERS";
export type Assessment = "STRENGTH" | "DEVELOPMENT_OPPORTUNITY" | "TYPICAL";

export interface MetricPosition {
  status: PositionStatus;
  /** Comparable employees in the viewer's scope, the subject included (the "team sample size"). */
  peerCount: number;
  /** Colleagues strictly better / equal / strictly worse than the subject (null without a position). */
  betterCount: number | null;
  sameCount: number | null;
  worseCount: number | null;
  /** 1 = best quarter ... 4 = lowest quarter; null without a position. */
  quartile: 1 | 2 | 3 | 4 | null;
  lowerIsBetter: boolean;
}

/** -1 when a's rate is below b's, 0 when equal, 1 when above (exact; both denominators > 0). */
export function compareRates(a: Pick<ComparableValue, "numerator" | "denominator">, b: Pick<ComparableValue, "numerator" | "denominator">): -1 | 0 | 1 {
  const left = BigInt(a.numerator) * BigInt(b.denominator);
  const right = BigInt(b.numerator) * BigInt(a.denominator);
  return left < right ? -1 : left > right ? 1 : 0;
}

const comparable = (value: ComparableValue) => value.enoughData && value.denominator > 0;

/** The subject's position among `peers` (the subject's own entry in `peers` is ignored; `subject` is used). */
export function positionAmong(subject: ComparableValue, peers: readonly ComparableValue[], kind: string): MetricPosition {
  const lower = lowerIsBetter(kind);
  const others = peers.filter((peer) => peer.employeeId !== subject.employeeId && comparable(peer));
  const peerCount = others.length + (comparable(subject) ? 1 : 0);
  const none = { betterCount: null, sameCount: null, worseCount: null, quartile: null, lowerIsBetter: lower };
  if (!comparable(subject)) return { status: "NOT_ENOUGH_DATA", peerCount, ...none };
  if (peerCount < MIN_PEERS_FOR_POSITION) return { status: "NOT_ENOUGH_PEERS", peerCount, ...none };
  let betterCount = 0;
  let sameCount = 0;
  for (const peer of others) {
    const comparison = compareRates(peer, subject) * (lower ? -1 : 1);
    if (comparison > 0) betterCount += 1;
    else if (comparison === 0) sameCount += 1;
  }
  // Mid-rank share of colleagues ahead of the subject: (better + same / 2) / peerCount, in quarters, in integers.
  const quartile = Math.min(4, Math.floor(((2 * betterCount + sameCount) * 2) / peerCount) + 1) as 1 | 2 | 3 | 4;
  return { status: "POSITIONED", peerCount, betterCount, sameCount, worseCount: others.length - betterCount - sameCount, quartile, lowerIsBetter: lower };
}

/** Best quarter = strength, lowest quarter = development opportunity; null without a position. */
export function assessmentOf(position: MetricPosition): Assessment | null {
  if (position.quartile === null) return null;
  if (position.quartile === 1) return "STRENGTH";
  if (position.quartile === 4) return "DEVELOPMENT_OPPORTUNITY";
  return "TYPICAL";
}
