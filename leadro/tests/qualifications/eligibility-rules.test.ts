import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_FAILURE_CODES,
  evaluateEligibility,
  type AvailabilityFact,
  type EligibilityQuery,
  type EligibilityRequirements,
  type EmployeeFacts,
  type QualificationFact,
} from "@/lib/eligibility";

const NY = "America/New_York";
const d = (value: string) => new Date(value);

/** Weekly window helper: `hhmm` strings are local to the zone. */
function weekly(isoDayOfWeek: number, from: string, to: string, extra: Partial<AvailabilityFact> = {}): AvailabilityFact {
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return {
    kind: "WEEKLY_WINDOW",
    timeZone: NY,
    isoDayOfWeek,
    startMinute: minutes(from),
    endMinute: minutes(to),
    validFrom: null,
    validTo: null,
    startsAt: null,
    endsAt: null,
    ...extra,
  };
}

const exception = (kind: "EXCEPTION_AVAILABLE" | "EXCEPTION_UNAVAILABLE", startsAt: string, endsAt: string): AvailabilityFact => ({
  kind,
  timeZone: NY,
  isoDayOfWeek: null,
  startMinute: null,
  endMinute: null,
  validFrom: null,
  validTo: null,
  startsAt: d(startsAt),
  endsAt: d(endsAt),
});

const verifiedSkill = (skillId: string, level: number, expiresAt: string | null = null): QualificationFact => ({
  skillId,
  certificationId: null,
  level,
  status: "VERIFIED",
  expiresAt: expiresAt ? d(`${expiresAt}T00:00:00Z`) : null,
});
const credential = (
  certificationId: string,
  status: QualificationFact["status"] = "VERIFIED",
  expiresAt: string | null = null,
): QualificationFact => ({
  skillId: null,
  certificationId,
  level: null,
  status,
  expiresAt: expiresAt ? d(`${expiresAt}T00:00:00Z`) : null,
});

// Monday 2026-11-23, 09:00-11:00 New York time = 14:00-16:00 UTC.
const MONDAY_WINDOW = { startsAt: d("2026-11-23T14:00:00Z"), endsAt: d("2026-11-23T16:00:00Z") };
const query = (extra: Partial<EligibilityQuery> = {}): EligibilityQuery => ({
  at: d("2026-11-22T12:00:00Z"),
  window: MONDAY_WINDOW,
  timeZone: NY,
  ...extra,
});

function facts(extra: Partial<EmployeeFacts> = {}): EmployeeFacts {
  return {
    employeeId: "emp",
    status: "ACTIVE",
    hireDate: d("2024-01-01T00:00:00Z"),
    terminationDate: null,
    qualifications: [],
    jobPermissions: [{ jobTypeId: null, category: "repair", effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }],
    territories: [{ orgUnitId: "city", includeDescendants: true, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }],
    availability: [weekly(1, "08:00", "17:00")],
    ...extra,
  };
}

const requirements = (extra: Partial<EligibilityRequirements> = {}): EligibilityRequirements => ({
  jobTypeId: "type-hvac",
  jobCategory: "repair",
  serviceArea: { orgUnitId: "team", ancestorOrgUnitIds: ["city", "state"] },
  skills: [],
  certifications: [],
  ...extra,
});

const codes = (result: ReturnType<typeof evaluateEligibility>) => result.failures.map((failure) => failure.code);

describe("evaluateEligibility: the happy path and employment", () => {
  it("is eligible when every hard requirement holds, and says which rules were evaluated", () => {
    const result = evaluateEligibility(
      facts({ qualifications: [verifiedSkill("hvac", 4), credential("epa")] }),
      requirements({ skills: [{ skillId: "hvac", minLevel: 3 }], certifications: [{ certificationId: "epa", kind: "LICENSE" }] }),
      query(),
    );
    expect(result).toEqual({
      eligible: true,
      failures: [],
      checked: { availability: true, territory: true, jobPermission: true },
    });
  });

  it("rejects an employee on leave or terminated, and one hired after the window or terminated before its end", () => {
    expect(codes(evaluateEligibility(facts({ status: "ON_LEAVE" }), requirements(), query()))).toEqual(["EMPLOYEE_NOT_ACTIVE"]);
    expect(codes(evaluateEligibility(facts({ status: "TERMINATED" }), requirements(), query()))).toEqual(["EMPLOYEE_NOT_ACTIVE"]);
    expect(codes(evaluateEligibility(facts({ hireDate: d("2026-11-24T00:00:00Z") }), requirements(), query()))).toEqual(["EMPLOYEE_NOT_EMPLOYED"]);
    expect(codes(evaluateEligibility(facts({ terminationDate: d("2026-11-22T00:00:00Z") }), requirements(), query()))).toEqual(["EMPLOYEE_NOT_EMPLOYED"]);
    // Terminated ON the window's day: that day is still their last working day.
    expect(evaluateEligibility(facts({ terminationDate: d("2026-11-23T00:00:00Z") }), requirements(), query()).eligible).toBe(true);
  });
});

describe("evaluateEligibility: skills and credentials", () => {
  it("reports a missing skill, a low level and a pending verification with distinct codes and params", () => {
    const needs = requirements({ skills: [{ skillId: "hvac", minLevel: 4, name: "HVAC" }] });
    const missing = evaluateEligibility(facts(), needs, query());
    expect(missing.failures).toEqual([{ code: "QUALIFICATION_MISSING", params: { kind: "SKILL", id: "hvac", name: "HVAC" } }]);

    const low = evaluateEligibility(facts({ qualifications: [verifiedSkill("hvac", 2)] }), needs, query());
    expect(low.failures).toEqual([
      { code: "SKILL_LEVEL_TOO_LOW", params: { kind: "SKILL", id: "hvac", name: "HVAC", requiredLevel: 4, actualLevel: 2 } },
    ]);

    const pending: QualificationFact = { ...verifiedSkill("hvac", 5), status: "PENDING_VERIFICATION" };
    expect(codes(evaluateEligibility(facts({ qualifications: [pending] }), needs, query()))).toEqual(["QUALIFICATION_NOT_VERIFIED"]);
  });

  it("treats rejected and revoked rows as not held", () => {
    for (const status of ["REJECTED", "REVOKED"] as const) {
      const result = evaluateEligibility(
        facts({ qualifications: [credential("epa", status)] }),
        requirements({ certifications: [{ certificationId: "epa", kind: "CERTIFICATION" }] }),
        query(),
      );
      expect(codes(result)).toEqual(["QUALIFICATION_MISSING"]);
    }
  });

  it("a credential is valid through the END of its expiry date in the job's time zone", () => {
    const needs = requirements({ certifications: [{ certificationId: "lic", kind: "LICENSE", name: "Electrical" }] });
    // Expires Monday 2026-11-23: the 09:00-11:00 window that day is still covered.
    expect(evaluateEligibility(facts({ qualifications: [credential("lic", "VERIFIED", "2026-11-23")] }), needs, query()).eligible).toBe(true);
    // Expired Sunday: the credential is gone by Monday morning.
    const expired = evaluateEligibility(facts({ qualifications: [credential("lic", "VERIFIED", "2026-11-22")] }), needs, query());
    expect(expired.failures).toEqual([
      { code: "QUALIFICATION_EXPIRED", params: { kind: "LICENSE", id: "lic", name: "Electrical", expiresOn: "2026-11-22" } },
    ]);
  });

  it("a credential that lapses before the job ends fails even though it is valid today", () => {
    const needs = requirements({ certifications: [{ certificationId: "lic", kind: "LICENSE" }] });
    const lapsesBeforeJob = facts({ qualifications: [credential("lic", "VERIFIED", "2026-11-25")] });
    const futureWindow = { startsAt: d("2026-11-30T14:00:00Z"), endsAt: d("2026-11-30T16:00:00Z") };
    expect(codes(evaluateEligibility(lapsesBeforeJob, needs, query({ window: futureWindow })))).toContain("QUALIFICATION_EXPIRED");
  });

  it("expiry day uses the job's zone, not UTC (a late-evening job on the expiry date still counts)", () => {
    const needs = requirements({ certifications: [{ certificationId: "lic", kind: "LICENSE" }] });
    // 22:00-23:00 New York on 2026-11-23 is 03:00-04:00 UTC on the 24th: after UTC midnight of the expiry date.
    const evening = { startsAt: d("2026-11-24T03:00:00Z"), endsAt: d("2026-11-24T04:00:00Z") };
    const holder = facts({ qualifications: [credential("lic", "VERIFIED", "2026-11-23")], availability: [weekly(1, "08:00", "24:00")] });
    expect(evaluateEligibility(holder, needs, query({ window: evening })).eligible).toBe(true);
  });

  it("a renewed credential (a second row) rescues an expired one; the best row counts", () => {
    const needs = requirements({ certifications: [{ certificationId: "lic", kind: "LICENSE" }] });
    const result = evaluateEligibility(
      facts({ qualifications: [credential("lic", "VERIFIED", "2025-01-01"), credential("lic", "VERIFIED", "2028-01-01")] }),
      needs,
      query(),
    );
    expect(result.eligible).toBe(true);
  });

  it("collects every failure, not just the first, in a stable order", () => {
    const result = evaluateEligibility(
      facts({ jobPermissions: [], territories: [], availability: [] }),
      requirements({ skills: [{ skillId: "hvac", minLevel: null }], certifications: [{ certificationId: "epa", kind: "CERTIFICATION" }] }),
      query(),
    );
    expect(codes(result)).toEqual([
      "QUALIFICATION_MISSING",
      "QUALIFICATION_MISSING",
      "JOB_PERMISSION_MISSING",
      "OUTSIDE_TERRITORY",
      "UNAVAILABLE_OUTSIDE_HOURS",
    ]);
    for (const failure of result.failures) expect(ELIGIBILITY_FAILURE_CODES).toContain(failure.code);
  });
});

describe("evaluateEligibility: job-category permissions", () => {
  it("accepts a permission for the job type or for its category, and refuses others", () => {
    const byType = facts({ jobPermissions: [{ jobTypeId: "type-hvac", category: null, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }] });
    const otherCategory = facts({ jobPermissions: [{ jobTypeId: null, category: "installation", effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }] });
    const otherType = facts({ jobPermissions: [{ jobTypeId: "type-other", category: null, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }] });
    expect(evaluateEligibility(byType, requirements(), query()).eligible).toBe(true);
    expect(codes(evaluateEligibility(otherCategory, requirements(), query()))).toEqual(["JOB_PERMISSION_MISSING"]);
    expect(codes(evaluateEligibility(otherType, requirements(), query()))).toEqual(["JOB_PERMISSION_MISSING"]);
  });

  it("a permission must cover the whole window: not yet started, or ending before the window ends", () => {
    const future = facts({ jobPermissions: [{ jobTypeId: null, category: "repair", effectiveFrom: d("2026-11-24T00:00:00Z"), effectiveTo: null }] });
    const endsMidWindow = facts({ jobPermissions: [{ jobTypeId: null, category: "repair", effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: d("2026-11-23T15:00:00Z") }] });
    const endsAtWindowEnd = facts({ jobPermissions: [{ jobTypeId: null, category: "repair", effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: d("2026-11-23T16:00:00Z") }] });
    expect(codes(evaluateEligibility(future, requirements(), query()))).toEqual(["JOB_PERMISSION_MISSING"]);
    expect(codes(evaluateEligibility(endsMidWindow, requirements(), query()))).toEqual(["JOB_PERMISSION_MISSING"]);
    expect(evaluateEligibility(endsAtWindowEnd, requirements(), query()).eligible).toBe(true);
  });

  it("skips the check when the work has neither a type nor a category", () => {
    const result = evaluateEligibility(facts({ jobPermissions: [] }), requirements({ jobTypeId: null, jobCategory: null }), query());
    expect(result.eligible).toBe(true);
    expect(result.checked.jobPermission).toBe(false);
  });
});

describe("evaluateEligibility: territories", () => {
  it("covers the unit itself, or its descendants only when the territory says so", () => {
    const exactUnit = facts({ territories: [{ orgUnitId: "team", includeDescendants: false, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }] });
    const ancestorNoDescendants = facts({ territories: [{ orgUnitId: "city", includeDescendants: false, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }] });
    const sibling = facts({ territories: [{ orgUnitId: "other-city", includeDescendants: true, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: null }] });
    expect(evaluateEligibility(exactUnit, requirements(), query()).eligible).toBe(true);
    expect(codes(evaluateEligibility(ancestorNoDescendants, requirements(), query()))).toEqual(["OUTSIDE_TERRITORY"]);
    expect(codes(evaluateEligibility(sibling, requirements(), query()))).toEqual(["OUTSIDE_TERRITORY"]);
  });

  it("an ended territory no longer covers later work", () => {
    const ended = facts({ territories: [{ orgUnitId: "city", includeDescendants: true, effectiveFrom: d("2025-01-01T00:00:00Z"), effectiveTo: d("2026-11-01T00:00:00Z") }] });
    expect(codes(evaluateEligibility(ended, requirements(), query()))).toEqual(["OUTSIDE_TERRITORY"]);
  });
});

describe("evaluateEligibility: availability in the employee's own time zone", () => {
  it("reads the weekly window in its zone: 09:00 New York is 14:00 UTC in winter and 13:00 UTC in summer", () => {
    const winter = { startsAt: d("2026-01-12T14:00:00Z"), endsAt: d("2026-01-12T15:00:00Z") }; // Mon 09:00-10:00 EST
    const summer = { startsAt: d("2026-07-13T13:00:00Z"), endsAt: d("2026-07-13T14:00:00Z") }; // Mon 09:00-10:00 EDT
    const lateSummer = { startsAt: d("2026-07-13T12:00:00Z"), endsAt: d("2026-07-13T13:00:00Z") }; // Mon 08:00-09:00 EDT
    const nineToFive = facts({ availability: [weekly(1, "09:00", "17:00")] });
    expect(evaluateEligibility(nineToFive, requirements(), query({ window: winter })).eligible).toBe(true);
    expect(evaluateEligibility(nineToFive, requirements(), query({ window: summer })).eligible).toBe(true);
    expect(codes(evaluateEligibility(nineToFive, requirements(), query({ window: lateSummer })))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
  });

  it("needs the whole window inside working hours; a window that starts early or ends late fails", () => {
    const nineToFive = facts({ availability: [weekly(1, "09:00", "17:00")] });
    const early = { startsAt: d("2026-11-23T13:30:00Z"), endsAt: d("2026-11-23T15:00:00Z") }; // 08:30-10:00
    const late = { startsAt: d("2026-11-23T21:00:00Z"), endsAt: d("2026-11-23T22:30:00Z") }; // 16:00-17:30
    const edge = { startsAt: d("2026-11-23T21:00:00Z"), endsAt: d("2026-11-23T22:00:00Z") }; // 16:00-17:00
    expect(codes(evaluateEligibility(nineToFive, requirements(), query({ window: early })))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
    expect(codes(evaluateEligibility(nineToFive, requirements(), query({ window: late })))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
    expect(evaluateEligibility(nineToFive, requirements(), query({ window: edge })).eligible).toBe(true);
  });

  it("a split shift covers a window inside either half but not the lunch gap", () => {
    const split = facts({ availability: [weekly(1, "08:00", "12:00"), weekly(1, "13:00", "17:00")] });
    const morning = { startsAt: d("2026-11-23T14:00:00Z"), endsAt: d("2026-11-23T16:00:00Z") }; // 09-11
    const overLunch = { startsAt: d("2026-11-23T16:30:00Z"), endsAt: d("2026-11-23T18:30:00Z") }; // 11:30-13:30
    expect(evaluateEligibility(split, requirements(), query({ window: morning })).eligible).toBe(true);
    expect(codes(evaluateEligibility(split, requirements(), query({ window: overLunch })))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
  });

  it("back-to-back windows merge: a night shift modelled as Mon 22-24 + Tue 00-06 covers 23:00-01:00", () => {
    const night = facts({ availability: [weekly(1, "22:00", "24:00"), weekly(2, "00:00", "06:00")] });
    const acrossMidnight = { startsAt: d("2026-11-24T04:00:00Z"), endsAt: d("2026-11-24T06:00:00Z") }; // Mon 23:00 - Tue 01:00 EST
    expect(evaluateEligibility(night, requirements(), query({ window: acrossMidnight })).eligible).toBe(true);
  });

  it("an employee with no availability rows is never available (no schedule is not 'free')", () => {
    expect(codes(evaluateEligibility(facts({ availability: [] }), requirements(), query()))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
  });

  it("time off beats the weekly window and is reported with its span; an extra-shift exception adds hours", () => {
    const sick = facts({ availability: [weekly(1, "08:00", "17:00"), exception("EXCEPTION_UNAVAILABLE", "2026-11-23T15:30:00Z", "2026-11-23T20:00:00Z")] });
    const result = evaluateEligibility(sick, requirements(), query());
    expect(result.failures).toEqual([
      { code: "UNAVAILABLE_TIME_OFF", params: { from: "2026-11-23T15:30:00.000Z", to: "2026-11-23T20:00:00.000Z" } },
    ]);

    const saturday = { startsAt: d("2026-11-28T15:00:00Z"), endsAt: d("2026-11-28T17:00:00Z") };
    const extraShift = facts({ availability: [weekly(1, "08:00", "17:00"), exception("EXCEPTION_AVAILABLE", "2026-11-28T14:00:00Z", "2026-11-28T20:00:00Z")] });
    expect(evaluateEligibility(extraShift, requirements(), query({ window: saturday })).eligible).toBe(true);
  });

  it("honours a window's validity dates", () => {
    const seasonal = facts({ availability: [weekly(1, "08:00", "17:00", { validTo: d("2026-11-16T00:00:00Z") })] });
    expect(codes(evaluateEligibility(seasonal, requirements(), query()))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
    const fromNextWeek = facts({ availability: [weekly(1, "08:00", "17:00", { validFrom: d("2026-11-30T00:00:00Z") })] });
    expect(codes(evaluateEligibility(fromNextWeek, requirements(), query()))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
  });

  it("evaluates a window per local date across DST: spring-forward day (02:30 start does not exist)", () => {
    // Sunday 2026-03-08. Window 02:30-06:00 local: the clocks jump 02:00 -> 03:00 (07:00Z), so the
    // window effectively starts at 03:00 EDT = 07:00Z and ends at 06:00 EDT = 10:00Z.
    const sunday = facts({ availability: [weekly(7, "02:30", "06:00")] });
    const covered = { startsAt: d("2026-03-08T07:00:00Z"), endsAt: d("2026-03-08T10:00:00Z") };
    const tooEarly = { startsAt: d("2026-03-08T06:30:00Z"), endsAt: d("2026-03-08T08:00:00Z") }; // 01:30 EST - 04:00 EDT
    expect(evaluateEligibility(sunday, requirements(), query({ window: covered })).eligible).toBe(true);
    expect(codes(evaluateEligibility(sunday, requirements(), query({ window: tooEarly })))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
  });

  it("evaluates a window per local date across DST: fall-back day (01:30 occurs twice)", () => {
    // Sunday 2026-11-01. A 01:00-02:00 window spans both passes of 01:xx: 05:00Z-07:00Z.
    const sunday = facts({ availability: [weekly(7, "01:00", "02:00")] });
    const bothPasses = { startsAt: d("2026-11-01T05:00:00Z"), endsAt: d("2026-11-01T07:00:00Z") };
    expect(evaluateEligibility(sunday, requirements(), query({ window: bothPasses })).eligible).toBe(true);
  });

  it("uses each window's own zone (an employee based in another zone)", () => {
    const london = facts({ availability: [weekly(1, "09:00", "17:00", { timeZone: "Europe/London" })] });
    const lateLondon = { startsAt: d("2026-11-23T16:00:00Z"), endsAt: d("2026-11-23T17:00:00Z") }; // 16:00-17:00 GMT
    const afterLondon = { startsAt: d("2026-11-23T17:00:00Z"), endsAt: d("2026-11-23T18:00:00Z") };
    expect(evaluateEligibility(london, requirements(), query({ window: lateLondon })).eligible).toBe(true);
    expect(codes(evaluateEligibility(london, requirements(), query({ window: afterLondon })))).toEqual(["UNAVAILABLE_OUTSIDE_HOURS"]);
  });

  it("without a window availability is not evaluated and the result says so", () => {
    const result = evaluateEligibility(facts({ availability: [] }), requirements(), query({ window: null }));
    expect(result.eligible).toBe(true);
    expect(result.checked.availability).toBe(false);
  });
});
