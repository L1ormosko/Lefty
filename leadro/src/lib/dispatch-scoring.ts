/**
 * Dispatch ranking (§7.3-7.4, §25.2, §28.6). PURE: no database, no clock, no randomness, no LLM.
 *
 * Ranking only ever sees employees who ALREADY passed the hard eligibility filter (skills, credentials,
 * territory, availability, job-category permission, active employment). It then orders them by four SOFT
 * factors and explains each one. By design there is NO performance factor (ratings, speed, revenue,
 * completion rate): performance must not remove access to ordinary work (§7.3, §10.3). Experience is a
 * COUNT of completed jobs of the same job type, which is exposure, not a quality judgement.
 *
 * Score = distance + workload + experience + preference, in points. Maximums and rules (documented in
 * docs/DECISIONS.md, tuned here only):
 *
 *   DISTANCE    0..40  straight-line km from the employee's start point to the job site, linear from 40
 *                      points at 0 km down to 0 at DISTANCE_CAP_KM (50). Unknown coordinates score the
 *                      neutral half (20) and raise a conflict: missing data must not punish anyone.
 *   WORKLOAD    0..30  open assigned jobs: 30 at none, minus 6 per open job, 0 from WORKLOAD_CAP (5) up.
 *   EXPERIENCE  0..20  completed jobs of this type: 2 points each, capped at EXPERIENCE_CAP (10) jobs.
 *   PREFERENCE  -30..10 the customer's list: PREFERRED +10, AVOID -30, none 0.
 *
 * Ties break by smaller distance (unknown last), then employee id, so the same input always gives the
 * same ranking. Distances are a labelled straight-line estimate, never travel time (§28.3).
 */

/** Bump when a weight or rule below changes, so stored recommendations say which rules produced them. */
export const SCORING_VERSION = 1;

export const DISTANCE_MAX_POINTS = 40;
export const DISTANCE_CAP_KM = 50;
export const WORKLOAD_MAX_POINTS = 30;
export const WORKLOAD_CAP = 5;
export const EXPERIENCE_MAX_POINTS = 20;
export const EXPERIENCE_CAP = 10;
export const PREFERRED_POINTS = 10;
export const AVOID_POINTS = -30;

export const SCORING_FACTOR_KEYS = ["DISTANCE", "WORKLOAD", "EXPERIENCE", "PREFERENCE"] as const;
export type ScoringFactorKey = (typeof SCORING_FACTOR_KEYS)[number];

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export type CustomerPreference = "PREFERRED" | "AVOID";

/** What the ranking needs to know about one eligible employee. All counts are non-negative integers. */
export interface CandidateFacts {
  employeeId: string;
  /** Null when either the employee or the job site has no coordinates. */
  distanceKm: number | null;
  /** Open (not finished or cancelled) jobs currently assigned to the employee. */
  openJobCount: number;
  /** Completed jobs of the same job type the employee has done. */
  completedOfTypeCount: number;
  customerPreference: CustomerPreference | null;
}

export interface FactorExplanation {
  key: ScoringFactorKey;
  /** The measured input (km, open jobs, completed jobs, the preference code); null when unknown. */
  value: number | CustomerPreference | null;
  /** Points this factor added (may be negative). */
  contribution: number;
  /** The most points this factor could add. */
  maxContribution: number;
  /** i18n key of the sentence explaining the factor; `explanationParams` are its placeholders. */
  explanationKey: string;
  explanationParams: Record<string, number | string>;
}

export const CONFLICT_CODES = ["CUSTOMER_AVOIDS_EMPLOYEE", "HEAVY_WORKLOAD", "DISTANCE_UNKNOWN", "FAR_FROM_JOB"] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

/** A soft warning the dispatcher should see before approving; never a block (blocks are eligibility's job). */
export interface Conflict {
  code: ConflictCode;
  /** i18n key: `DISPATCH.CONFLICT.<CODE>`. */
  messageKey: string;
}

export interface RankedCandidate {
  employeeId: string;
  rank: number;
  score: number;
  factors: FactorExplanation[];
  conflicts: Conflict[];
}

const EARTH_RADIUS_KM = 6371.0088;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle (straight-line over the surface) distance in km. NOT a road or travel-time estimate. */
export function haversineKm(from: GeoPoint, to: GeoPoint): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Rounds to one decimal so stored scores and explanations are stable and readable. */
const round1 = (value: number): number => Math.round(value * 10) / 10;

function distanceFactor(distanceKm: number | null): FactorExplanation {
  if (distanceKm === null) {
    return {
      key: "DISTANCE",
      value: null,
      contribution: DISTANCE_MAX_POINTS / 2,
      maxContribution: DISTANCE_MAX_POINTS,
      explanationKey: "DISPATCH.FACTOR.DISTANCE_UNKNOWN",
      explanationParams: {},
    };
  }
  const km = round1(distanceKm);
  const contribution = round1(DISTANCE_MAX_POINTS * Math.max(0, 1 - Math.min(distanceKm, DISTANCE_CAP_KM) / DISTANCE_CAP_KM));
  return { key: "DISTANCE", value: km, contribution, maxContribution: DISTANCE_MAX_POINTS, explanationKey: "DISPATCH.FACTOR.DISTANCE", explanationParams: { km } };
}

function workloadFactor(openJobCount: number): FactorExplanation {
  const contribution = round1(WORKLOAD_MAX_POINTS * Math.max(0, 1 - openJobCount / WORKLOAD_CAP));
  return {
    key: "WORKLOAD",
    value: openJobCount,
    contribution,
    maxContribution: WORKLOAD_MAX_POINTS,
    explanationKey: "DISPATCH.FACTOR.WORKLOAD",
    explanationParams: { count: openJobCount },
  };
}

function experienceFactor(completedOfTypeCount: number): FactorExplanation {
  const contribution = round1((EXPERIENCE_MAX_POINTS * Math.min(completedOfTypeCount, EXPERIENCE_CAP)) / EXPERIENCE_CAP);
  return {
    key: "EXPERIENCE",
    value: completedOfTypeCount,
    contribution,
    maxContribution: EXPERIENCE_MAX_POINTS,
    explanationKey: "DISPATCH.FACTOR.EXPERIENCE",
    explanationParams: { count: completedOfTypeCount },
  };
}

function preferenceFactor(preference: CustomerPreference | null): FactorExplanation {
  const contribution = preference === "PREFERRED" ? PREFERRED_POINTS : preference === "AVOID" ? AVOID_POINTS : 0;
  return {
    key: "PREFERENCE",
    value: preference,
    contribution,
    maxContribution: PREFERRED_POINTS,
    explanationKey: `DISPATCH.FACTOR.PREFERENCE_${preference ?? "NONE"}`,
    explanationParams: {},
  };
}

function conflictsOf(facts: CandidateFacts): Conflict[] {
  const codes: ConflictCode[] = [];
  if (facts.customerPreference === "AVOID") codes.push("CUSTOMER_AVOIDS_EMPLOYEE");
  if (facts.openJobCount >= WORKLOAD_CAP) codes.push("HEAVY_WORKLOAD");
  if (facts.distanceKm === null) codes.push("DISTANCE_UNKNOWN");
  else if (facts.distanceKm >= DISTANCE_CAP_KM) codes.push("FAR_FROM_JOB");
  return codes.map((code) => ({ code, messageKey: `DISPATCH.CONFLICT.${code}` }));
}

/** Scores one eligible employee: the four factors, their sum and the conflicts. */
export function scoreCandidate(facts: CandidateFacts): Omit<RankedCandidate, "rank"> {
  const factors = [distanceFactor(facts.distanceKm), workloadFactor(facts.openJobCount), experienceFactor(facts.completedOfTypeCount), preferenceFactor(facts.customerPreference)];
  const score = round1(factors.reduce((sum, factor) => sum + factor.contribution, 0));
  return { employeeId: facts.employeeId, score, factors, conflicts: conflictsOf(facts) };
}

/** Ranks eligible employees best-first (rank starts at 1). Deterministic: score, then nearer, then employee id. */
export function rankCandidates(candidates: readonly CandidateFacts[]): RankedCandidate[] {
  const distanceOf = new Map(candidates.map((candidate) => [candidate.employeeId, candidate.distanceKm ?? Number.POSITIVE_INFINITY]));
  return candidates
    .map(scoreCandidate)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (distanceOf.get(a.employeeId) as number) - (distanceOf.get(b.employeeId) as number) ||
        (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
