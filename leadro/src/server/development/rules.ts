import { addDays, endOfLocalDay } from "@/lib/zoned-time";
import type { TenantTx } from "@/server/db";
import { evaluateCandidates, qualificationWarningDays, requirementsForJobType } from "@/server/qualifications";
import { isoDateOf } from "./access";
import { isLowerBetterKind, loadDevelopmentThresholds } from "./thresholds";

/**
 * The training-recommendation rules (spec 5.4 "recommend training", 10.4). Deterministic and explainable: the same data
 * gives the same reasons, every reason is a code plus the ids / numbers behind it (never free text), and a recommendation
 * only proposes a course; a person accepts or dismisses it (spec 28.6). Development use only (spec 10.3): the rules READ
 * qualifications and published metric values; they write nothing that dispatch, eligibility, pay or employment reads.
 *
 * A course is recommended for a certification when it is ACTIVE and grants that TRAINING certification (if several do,
 * the one with the smallest code, so the choice is stable).
 *
 * 1. `certification_expired` / `certification_expiring`: the employee's TRAINING certification has expired, or expires
 *    within the tenant's `qualificationWarningDays`, and no renewal is pending HR verification (the qualification
 *    module's verdict QUALIFICATION_EXPIRED, judged at the end of the warning horizon).
 * 2. `job_type_training_missing`: an active job type requires a TRAINING certification the employee does not hold, and
 *    training is the ONLY thing missing for it (every eligibility failure for the job type is a missing or expired
 *    TRAINING certification that some course grants). A job type the employee is not otherwise qualified or permitted
 *    for is not a training need. Judged with the qualification module's `evaluateCandidates` (no territory, no window).
 * 3. `metric_below_threshold`: the employee's current value (latest period, newest computation) of a PUBLISHED metric
 *    definition with enough data is below the tenant's development threshold for that metric key
 *    (numerator x 1000 < belowMilli x denominator). Disabled when no threshold is configured.
 */

export type RecommendationReason =
  | { code: "certification_expired"; certificationId: string; expiresOn: string }
  | { code: "certification_expiring"; certificationId: string; expiresOn: string; daysRemaining: number }
  | { code: "job_type_training_missing"; jobTypeId: string; certificationId: string }
  | {
      code: "metric_below_threshold";
      metricKey: string;
      definitionId: string;
      metricValueId: string;
      periodStart: string;
      periodEnd: string;
      jobTypeId: string | null;
      jobCategory: string | null;
      numerator: number;
      denominator: number;
      sampleSize: number;
      belowMilli: number;
    };

export const RECOMMENDATION_REASON_CODES = ["certification_expired", "certification_expiring", "job_type_training_missing", "metric_below_threshold"] as const;

/**
 * What a reason is ABOUT, independent of when it was computed: two reasons with the same identity are the same finding
 * (e.g. the same certification lapsing on the same date, the same metric in the same period). A decided recommendation
 * suppresses new ones whose reasons it already covered.
 */
export function reasonIdentity(reason: RecommendationReason): string {
  switch (reason.code) {
    case "certification_expired":
    case "certification_expiring":
      return `certification:${reason.certificationId}:${reason.expiresOn}`;
    case "job_type_training_missing":
      return `job_type:${reason.jobTypeId}:${reason.certificationId}`;
    case "metric_below_threshold":
      return `metric:${reason.metricKey}:${reason.periodStart}:${reason.jobTypeId ?? ""}:${reason.jobCategory ?? ""}`;
  }
}

/** `${employeeId}:${courseId}` -> the reasons found for that pair, in rule order. */
export type ReasonsByPair = Map<string, { employeeId: string; courseId: string; reasons: RecommendationReason[] }>;

export const pairKey = (employeeId: string, courseId: string): string => `${employeeId}:${courseId}`;

function addReason(map: ReasonsByPair, employeeId: string, courseId: string, reason: RecommendationReason): void {
  const key = pairKey(employeeId, courseId);
  const entry = map.get(key) ?? { employeeId, courseId, reasons: [] };
  if (!entry.reasons.some((existing) => reasonIdentity(existing) === reasonIdentity(reason))) entry.reasons.push(reason);
  map.set(key, entry);
}

const DAY_MS = 86_400_000;
const daysBetween = (fromIsoDate: string, toIsoDate: string): number => Math.round((Date.parse(toIsoDate) - Date.parse(fromIsoDate)) / DAY_MS);

/** Active courses that grant a TRAINING certification: certificationId -> the course with the smallest code. */
async function courseByTrainingCertification(tx: TenantTx, tenantId: string): Promise<Map<string, string>> {
  const courses = await tx.trainingCourse.findMany({
    where: { tenantId, active: true, certification: { type: "TRAINING" } },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    select: { id: true, certificationId: true },
  });
  const map = new Map<string, string>();
  for (const course of courses) if (course.certificationId && !map.has(course.certificationId)) map.set(course.certificationId, course.id);
  return map;
}

/**
 * Evaluates every rule for `employeeIds` (callers pass ACTIVE employees only) on `today` (tenant-local) in `timeZone`.
 * Reads only; returns the reasons per employee and course.
 */
export async function evaluateRecommendationRules(
  tx: TenantTx,
  tenantId: string,
  employeeIds: string[],
  calendar: { today: string; timeZone: string; now: Date },
): Promise<ReasonsByPair> {
  const reasons: ReasonsByPair = new Map();
  if (employeeIds.length === 0) return reasons;
  const courses = await courseByTrainingCertification(tx, tenantId);

  if (courses.size > 0) {
    await expiryRule(tx, tenantId, employeeIds, courses, calendar, reasons);
    await jobTypeRule(tx, tenantId, employeeIds, courses, calendar, reasons);
  }
  await metricRule(tx, tenantId, employeeIds, reasons);
  return reasons;
}

/** Rule 1: expired / expiring TRAINING certifications. */
async function expiryRule(
  tx: TenantTx,
  tenantId: string,
  employeeIds: string[],
  courses: Map<string, string>,
  calendar: { today: string; timeZone: string },
  reasons: ReasonsByPair,
): Promise<void> {
  const warningDays = await qualificationWarningDays(tx, tenantId);
  // Judged at the first instant after the horizon day: a certification dated on or before today + warningDays fails.
  const at = new Date(endOfLocalDay(addDays(calendar.today, warningDays), calendar.timeZone));
  const requirements = {
    jobTypeId: null,
    jobCategory: null,
    serviceArea: null,
    skills: [],
    certifications: [...courses.keys()].map((certificationId) => ({ certificationId, kind: "TRAINING" as const })),
  };
  const verdicts = await evaluateCandidates(tx, tenantId, employeeIds, requirements, { at, window: null, timeZone: calendar.timeZone });
  for (const [employeeId, verdict] of verdicts) {
    for (const failure of verdict.failures) {
      // MISSING is not an expiry (rule 2 decides whether it matters); NOT_VERIFIED / RENEWAL_PENDING wait for HR.
      if (failure.code !== "QUALIFICATION_EXPIRED") continue;
      const certificationId = String(failure.params.id);
      const expiresOn = failure.params.expiresOn;
      const courseId = courses.get(certificationId);
      if (!courseId || typeof expiresOn !== "string") continue;
      const daysRemaining = daysBetween(calendar.today, expiresOn);
      addReason(
        reasons,
        employeeId,
        courseId,
        daysRemaining < 0 ? { code: "certification_expired", certificationId, expiresOn } : { code: "certification_expiring", certificationId, expiresOn, daysRemaining },
      );
    }
  }
}

/** Rule 2: job types for which a TRAINING certification is the only thing the employee lacks. */
async function jobTypeRule(
  tx: TenantTx,
  tenantId: string,
  employeeIds: string[],
  courses: Map<string, string>,
  calendar: { timeZone: string; now: Date },
  reasons: ReasonsByPair,
): Promise<void> {
  // Ownership note: JobType is job configuration; only the ids of active types with a TRAINING requirement are read here,
  // the requirements themselves come from the qualifications module (`requirementsForJobType`).
  const rows = await tx.jobTypeCertification.findMany({
    where: { tenantId, jobType: { active: true }, certification: { type: "TRAINING" } },
    select: { jobTypeId: true },
    distinct: ["jobTypeId"],
    orderBy: { jobTypeId: "asc" },
  });
  for (const { jobTypeId } of rows) {
    const requirements = await requirementsForJobType(tx, tenantId, jobTypeId);
    const verdicts = await evaluateCandidates(tx, tenantId, employeeIds, requirements, { at: calendar.now, window: null, timeZone: calendar.timeZone });
    for (const [employeeId, verdict] of verdicts) {
      if (verdict.eligible) continue;
      const trainingOnly = verdict.failures.every(
        (failure) =>
          (failure.code === "QUALIFICATION_MISSING" || failure.code === "QUALIFICATION_EXPIRED") &&
          failure.params.kind === "TRAINING" &&
          courses.has(String(failure.params.id)),
      );
      if (!trainingOnly) continue;
      for (const failure of verdict.failures) {
        if (failure.code !== "QUALIFICATION_MISSING") continue; // an expired one is rule 1's reason
        const certificationId = String(failure.params.id);
        addReason(reasons, employeeId, courses.get(certificationId) as string, { code: "job_type_training_missing", jobTypeId, certificationId });
      }
    }
  }
}

/**
 * Rule 3: current metric values below the tenant's development threshold. Reads PerformanceMetricValue / Definition
 * directly (append-only tables; the performance module computes them): only PUBLISHED definitions, only values with
 * enough data, never a kind where lower is better.
 */
async function metricRule(tx: TenantTx, tenantId: string, employeeIds: string[], reasons: ReasonsByPair): Promise<void> {
  const thresholds = await loadDevelopmentThresholds(tx, tenantId);
  if (thresholds.length === 0) return;
  const activeCourseIds = new Set(
    (await tx.trainingCourse.findMany({ where: { tenantId, active: true, id: { in: thresholds.map((entry) => entry.courseId) } }, select: { id: true } })).map((row) => row.id),
  );
  const definitions = await tx.performanceMetricDefinition.findMany({
    where: { tenantId, status: "PUBLISHED", key: { in: thresholds.map((entry) => entry.metricKey) } },
    select: { id: true, key: true, kind: true },
  });
  const usable = definitions.filter((definition) => !isLowerBetterKind(definition.kind));
  if (usable.length === 0) return;
  const byKey = new Map(thresholds.map((entry) => [entry.metricKey, entry]));
  const keyOfDefinition = new Map(usable.map((definition) => [definition.id, definition.key]));

  const values = await tx.performanceMetricValue.findMany({
    where: { tenantId, employeeId: { in: employeeIds }, definitionId: { in: usable.map((definition) => definition.id) } },
    orderBy: [{ periodStart: "desc" }, { computedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      definitionId: true,
      employeeId: true,
      periodStart: true,
      periodEnd: true,
      jobTypeId: true,
      jobCategory: true,
      numerator: true,
      denominator: true,
      sampleSize: true,
      enoughData: true,
    },
  });
  // The current value of each series (employee x definition x breakdown) is the first one in this order.
  const seen = new Set<string>();
  for (const value of values) {
    const series = `${value.employeeId}:${value.definitionId}:${value.jobTypeId ?? ""}:${value.jobCategory ?? ""}`;
    if (seen.has(series)) continue;
    seen.add(series);
    const metricKey = keyOfDefinition.get(value.definitionId) as string;
    const threshold = byKey.get(metricKey);
    if (!threshold || !activeCourseIds.has(threshold.courseId)) continue;
    // "Not enough data" never counts against anyone (spec 10.4); a zero denominator has no rate.
    if (!value.enoughData || value.denominator <= 0) continue;
    if (value.numerator * 1000 >= threshold.belowMilli * value.denominator) continue;
    addReason(reasons, value.employeeId, threshold.courseId, {
      code: "metric_below_threshold",
      metricKey,
      definitionId: value.definitionId,
      metricValueId: value.id,
      periodStart: isoDateOf(value.periodStart) as string,
      periodEnd: isoDateOf(value.periodEnd) as string,
      jobTypeId: value.jobTypeId,
      jobCategory: value.jobCategory,
      numerator: value.numerator,
      denominator: value.denominator,
      sampleSize: value.sampleSize,
      belowMilli: threshold.belowMilli,
    });
  }
}
