import { endOfLocalDay, startOfLocalDay } from "../zoned-time";
import { checkAvailability } from "./availability";
import type {
  CertificationRequirement,
  EligibilityFailure,
  EligibilityQuery,
  EligibilityRequirements,
  EligibilityResult,
  EmployeeFacts,
  QualificationFact,
  SkillRequirement,
} from "./types";

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);

/** The span the employee must hold everything for: the window, or just the decision instant. */
function neededSpan(query: EligibilityQuery): { first: number; last: number } {
  if (query.window) return { first: query.window.startsAt.getTime(), last: query.window.endsAt.getTime() - 1 };
  return { first: query.at.getTime(), last: query.at.getTime() };
}

/** A credential dated `expiresAt` is valid through the END of that calendar day in the job's zone. */
function hasExpiredBy(expiresAt: Date | null, lastNeeded: number, zone: string): boolean {
  return expiresAt !== null && lastNeeded >= endOfLocalDay(dateOnly(expiresAt), zone);
}

type RowVerdict = "OK" | "LEVEL_TOO_LOW" | "EXPIRED" | "NOT_VERIFIED";

/**
 * Judges the employee's rows for ONE required skill or credential. Several rows can exist (a renewed
 * credential is a new row), so the best one counts: any row that passes wins; otherwise the most
 * informative failure is reported (a low level, then expired, then awaiting verification). REJECTED
 * and REVOKED rows count as not held.
 */
function judgeRows(
  rows: QualificationFact[],
  minLevel: number | null,
  query: EligibilityQuery,
): { verdict: RowVerdict | "MISSING"; expiresAt: Date | null; level: number | null } {
  const { last } = neededSpan(query);
  let best: { verdict: RowVerdict | "MISSING"; expiresAt: Date | null; level: number | null } = {
    verdict: "MISSING",
    expiresAt: null,
    level: null,
  };
  const rank: Record<RowVerdict | "MISSING", number> = { OK: 4, LEVEL_TOO_LOW: 3, EXPIRED: 2, NOT_VERIFIED: 1, MISSING: 0 };

  for (const row of rows) {
    if (row.status === "REJECTED" || row.status === "REVOKED") continue;
    let verdict: RowVerdict;
    if (row.status === "PENDING_VERIFICATION") verdict = "NOT_VERIFIED";
    else if (hasExpiredBy(row.expiresAt, last, query.timeZone)) verdict = "EXPIRED";
    else if (minLevel !== null && (row.level ?? 0) < minLevel) verdict = "LEVEL_TOO_LOW";
    else verdict = "OK";
    if (rank[verdict] > rank[best.verdict]) best = { verdict, expiresAt: row.expiresAt, level: row.level };
  }
  return best;
}

function failureForSkill(
  requirement: SkillRequirement,
  rows: QualificationFact[],
  query: EligibilityQuery,
): EligibilityFailure | null {
  const judged = judgeRows(rows, requirement.minLevel, query);
  const base = { kind: "SKILL", id: requirement.skillId, name: requirement.name ?? null };
  switch (judged.verdict) {
    case "OK":
      return null;
    case "MISSING":
      return { code: "QUALIFICATION_MISSING", params: base };
    case "NOT_VERIFIED":
      return { code: "QUALIFICATION_NOT_VERIFIED", params: base };
    case "EXPIRED":
      return { code: "QUALIFICATION_EXPIRED", params: { ...base, expiresOn: judged.expiresAt ? dateOnly(judged.expiresAt) : null } };
    case "LEVEL_TOO_LOW":
      return { code: "SKILL_LEVEL_TOO_LOW", params: { ...base, requiredLevel: requirement.minLevel, actualLevel: judged.level } };
  }
}

function failureForCertification(
  requirement: CertificationRequirement,
  rows: QualificationFact[],
  query: EligibilityQuery,
): EligibilityFailure | null {
  const judged = judgeRows(rows, null, query);
  const base = { kind: requirement.kind ?? "CERTIFICATION", id: requirement.certificationId, name: requirement.name ?? null };
  switch (judged.verdict) {
    case "OK":
    case "LEVEL_TOO_LOW": // cannot happen without a minimum level
      return null;
    case "MISSING":
      return { code: "QUALIFICATION_MISSING", params: base };
    case "NOT_VERIFIED":
      return { code: "QUALIFICATION_NOT_VERIFIED", params: base };
    case "EXPIRED":
      return { code: "QUALIFICATION_EXPIRED", params: { ...base, expiresOn: judged.expiresAt ? dateOnly(judged.expiresAt) : null } };
  }
}

/** A time-bounded grant (job permission, territory) must cover the whole needed span. */
const coversSpan = (from: Date, to: Date | null, span: { first: number; last: number }): boolean =>
  from.getTime() <= span.first && (to === null || to.getTime() > span.last);

/**
 * The qualification engine's verdict (§10.1, §7.3 hard requirements): is this employee allowed to do
 * this work in this time span? Pure and deterministic; every rule that fails is reported with a
 * language-neutral code and params, in this stable order:
 *
 *  1. employment: ACTIVE now, hired and not terminated across the span;
 *  2. every required skill (verified, not expired by the end of the span, at least the minimum level);
 *  3. every required certification / license / equipment / training (verified and unexpired);
 *  4. a job-category permission (the job type OR its category) covering the span;
 *  5. a service territory covering the job's service area (descendants if the territory says so);
 *  6. availability for the whole window (only when a window is given).
 *
 * Nothing here looks at performance, ratings, history or workload (§10.3): "eligible" only says the
 * employee MAY do the work. Ranking among the eligible is the dispatch engine's job.
 */
export function evaluateEligibility(
  facts: EmployeeFacts,
  requirements: EligibilityRequirements,
  query: EligibilityQuery,
): EligibilityResult {
  const failures: EligibilityFailure[] = [];
  const span = neededSpan(query);

  // 1. Employment
  if (facts.status !== "ACTIVE") {
    failures.push({ code: "EMPLOYEE_NOT_ACTIVE", params: { status: facts.status } });
  } else {
    const startsBeforeHire = facts.hireDate !== null && span.first < startOfLocalDay(dateOnly(facts.hireDate), query.timeZone);
    const endsAfterTermination =
      facts.terminationDate !== null && span.last >= endOfLocalDay(dateOnly(facts.terminationDate), query.timeZone);
    if (startsBeforeHire || endsAfterTermination) {
      failures.push({
        code: "EMPLOYEE_NOT_EMPLOYED",
        params: {
          hireDate: facts.hireDate ? dateOnly(facts.hireDate) : null,
          terminationDate: facts.terminationDate ? dateOnly(facts.terminationDate) : null,
        },
      });
    }
  }

  // 2 + 3. Skills, then credentials
  for (const requirement of requirements.skills) {
    const rows = facts.qualifications.filter((row) => row.skillId === requirement.skillId);
    const failure = failureForSkill(requirement, rows, query);
    if (failure) failures.push(failure);
  }
  for (const requirement of requirements.certifications) {
    const rows = facts.qualifications.filter((row) => row.certificationId === requirement.certificationId);
    const failure = failureForCertification(requirement, rows, query);
    if (failure) failures.push(failure);
  }

  // 4. Job-category permission: a row for this job type, or for its category
  const needsPermission = requirements.jobTypeId !== null || requirements.jobCategory !== null;
  if (needsPermission) {
    const permitted = facts.jobPermissions.some(
      (permission) =>
        coversSpan(permission.effectiveFrom, permission.effectiveTo, span) &&
        ((permission.jobTypeId !== null && permission.jobTypeId === requirements.jobTypeId) ||
          (permission.category !== null && permission.category === requirements.jobCategory)),
    );
    if (!permitted) {
      failures.push({
        code: "JOB_PERMISSION_MISSING",
        params: { jobTypeId: requirements.jobTypeId, category: requirements.jobCategory },
      });
    }
  }

  // 5. Territory
  const area = requirements.serviceArea;
  if (area) {
    const covered = facts.territories.some(
      (territory) =>
        coversSpan(territory.effectiveFrom, territory.effectiveTo, span) &&
        (territory.orgUnitId === area.orgUnitId ||
          (territory.includeDescendants && area.ancestorOrgUnitIds.includes(territory.orgUnitId))),
    );
    if (!covered) failures.push({ code: "OUTSIDE_TERRITORY", params: { orgUnitId: area.orgUnitId } });
  }

  // 6. Availability
  if (query.window) {
    const verdict = checkAvailability(facts.availability, {
      start: query.window.startsAt.getTime(),
      end: query.window.endsAt.getTime(),
    });
    if (!verdict.available) {
      failures.push(
        verdict.reason === "TIME_OFF"
          ? {
              code: "UNAVAILABLE_TIME_OFF",
              params: { from: new Date(verdict.blockedBy.start).toISOString(), to: new Date(verdict.blockedBy.end).toISOString() },
            }
          : {
              code: "UNAVAILABLE_OUTSIDE_HOURS",
              params: { from: query.window.startsAt.toISOString(), to: query.window.endsAt.toISOString() },
            },
      );
    }
  }

  return {
    eligible: failures.length === 0,
    failures,
    checked: { availability: query.window !== null, territory: area !== null, jobPermission: needsPermission },
  };
}
