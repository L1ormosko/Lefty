import { describe, expect, it } from "vitest";
import {
  aggregateOpportunities,
  attributeVisit,
  documentationOpportunities,
  feedbackOpportunities,
  METRIC_KIND_CATALOG,
  METRIC_KINDS,
  normalizeMetricParams,
  onTimeArrivalOpportunities,
  outcomeConversionOpportunities,
  periodLengthDays,
  recoveryConversionOpportunities,
  repeatVisitOpportunities,
  trainingProgressOpportunities,
  type CompletedVisit,
} from "@/lib/performance-formulas";

const at = (iso: string) => new Date(iso);
const job = { jobTypeId: "type-1", jobCategory: "repair" };

function visit(id: string, completedAt: string, overrides: Partial<CompletedVisit> = {}): CompletedVisit {
  return {
    jobId: id,
    customerId: "cust-1",
    completedAt: at(completedAt),
    leadAssignments: [{ employeeId: "emp-1", assignedAt: at("2026-01-01T00:00:00Z"), endedAt: null }],
    ...job,
    ...overrides,
  };
}

describe("metric kind catalog", () => {
  it("fixes one dimension per kind and only TRAINING_PROGRESS is not job-based", () => {
    expect(METRIC_KINDS.map((kind) => METRIC_KIND_CATALOG[kind].dimension)).toEqual([
      "REPEAT_VISITS", "TIMELINESS", "DOCUMENTATION", "SALES", "SALES", "CUSTOMER_FEEDBACK", "TRAINING_PROGRESS",
    ]);
    expect(METRIC_KINDS.filter((kind) => !METRIC_KIND_CATALOG[kind].jobBased)).toEqual(["TRAINING_PROGRESS"]);
  });
});

describe("normalizeMetricParams", () => {
  it("defaults the breakdown to JOB_TYPE and requires windowDays for repeat visits", () => {
    expect(normalizeMetricParams("ON_TIME_ARRIVAL", {})).toEqual({ ok: true, params: { breakdown: "JOB_TYPE" } });
    expect(normalizeMetricParams("REPEAT_VISIT_RATE", { windowDays: 30, breakdown: "JOB_CATEGORY" })).toEqual({ ok: true, params: { breakdown: "JOB_CATEGORY", windowDays: 30 } });
    expect(normalizeMetricParams("REPEAT_VISIT_RATE", {}).ok).toBe(false);
    expect(normalizeMetricParams("REPEAT_VISIT_RATE", { windowDays: 0 }).ok).toBe(false);
    expect(normalizeMetricParams("REPEAT_VISIT_RATE", { windowDays: 2.5 }).ok).toBe(false);
  });

  it("refuses unknown keys (no weights or thresholds) and a breakdown on training progress", () => {
    const weighted = normalizeMetricParams("OUTCOME_CONVERSION", { weight: 2 });
    expect(weighted.ok).toBe(false);
    if (!weighted.ok) expect(weighted.problems[0]?.path).toBe("weight");
    expect(normalizeMetricParams("TRAINING_PROGRESS", { breakdown: "JOB_TYPE" }).ok).toBe(false);
    expect(normalizeMetricParams("TRAINING_PROGRESS", {})).toEqual({ ok: true, params: { breakdown: null } });
    expect(normalizeMetricParams("ON_TIME_ARRIVAL", { breakdown: "TEAM" }).ok).toBe(false);
  });
});

describe("attributeVisit", () => {
  it("picks the LEAD assignment in effect at completion", () => {
    const leadAssignments = [
      { employeeId: "early", assignedAt: at("2026-01-01T00:00:00Z"), endedAt: at("2026-01-05T00:00:00Z") },
      { employeeId: "current", assignedAt: at("2026-01-05T00:00:00Z"), endedAt: null },
      { employeeId: "later", assignedAt: at("2026-02-01T00:00:00Z"), endedAt: null },
    ];
    expect(attributeVisit({ completedAt: at("2026-01-10T00:00:00Z"), leadAssignments })).toBe("current");
    expect(attributeVisit({ completedAt: at("2026-01-03T00:00:00Z"), leadAssignments })).toBe("early");
    expect(attributeVisit({ completedAt: at("2025-12-01T00:00:00Z"), leadAssignments })).toBeNull();
  });
});

describe("repeatVisitOpportunities", () => {
  const now = at("2026-03-01T00:00:00Z");

  it("counts a later job of the same customer and type within the window as a repeat", () => {
    const visits = [visit("j1", "2026-01-10T00:00:00Z"), visit("j2", "2026-01-12T00:00:00Z")];
    const later = [
      { jobId: "j3", customerId: "cust-1", jobTypeId: "type-1", createdAt: at("2026-01-20T00:00:00Z") },
      { jobId: "j4", customerId: "cust-1", jobTypeId: "type-2", createdAt: at("2026-01-21T00:00:00Z") },
    ];
    const result = repeatVisitOpportunities(visits, later, 9, now);
    expect(result.map((row) => [row.evidenceId, row.contribution])).toEqual([["j1", 0], ["j2", 1]]);
  });

  it("ignores the visit itself, other customers and jobs created before completion", () => {
    const visits = [visit("j1", "2026-01-10T00:00:00Z")];
    const later = [
      { jobId: "j1", customerId: "cust-1", jobTypeId: "type-1", createdAt: at("2026-01-11T00:00:00Z") },
      { jobId: "j5", customerId: "cust-2", jobTypeId: "type-1", createdAt: at("2026-01-11T00:00:00Z") },
      { jobId: "j6", customerId: "cust-1", jobTypeId: "type-1", createdAt: at("2026-01-09T00:00:00Z") },
    ];
    expect(repeatVisitOpportunities(visits, later, 30, now)[0]?.contribution).toBe(0);
  });

  it("leaves out visits whose window has not elapsed yet", () => {
    expect(repeatVisitOpportunities([visit("j1", "2026-02-25T00:00:00Z")], [], 7, now)).toEqual([]);
  });
});

describe("the other kinds", () => {
  it("on-time arrival: at or before the window end", () => {
    const rows = onTimeArrivalOpportunities([
      { arrivalId: "a1", employeeId: "e", arrivedAt: at("2026-01-01T10:00:00Z"), appointmentWindowEnd: at("2026-01-01T10:00:00Z"), ...job },
      { arrivalId: "a2", employeeId: "e", arrivedAt: at("2026-01-01T10:01:00Z"), appointmentWindowEnd: at("2026-01-01T10:00:00Z"), ...job },
    ]);
    expect(rows.map((row) => row.contribution)).toEqual([1, 0]);
  });

  it("documentation: only visits needing a form count; submitted = complete", () => {
    const rows = documentationOpportunities([
      { ...visit("j1", "2026-01-10T00:00:00Z"), formRequired: true, completionSubmitted: true },
      { ...visit("j2", "2026-01-10T00:00:00Z"), formRequired: true, completionSubmitted: false },
      { ...visit("j3", "2026-01-10T00:00:00Z"), formRequired: false, completionSubmitted: false },
    ]);
    expect(rows.map((row) => [row.evidenceId, row.contribution])).toEqual([["j1", 1], ["j2", 0]]);
  });

  it("outcome conversion: only sales decisions are opportunities", () => {
    const rows = outcomeConversionOpportunities(
      ["SOLD", "NOT_SOLD", "CUSTOMER_UNAVAILABLE", "RESCHEDULE_REQUIRED", "WORK_NOT_POSSIBLE", "ADDITIONAL_APPROVAL_REQUIRED"].map((outcome, index) => ({
        outcomeId: `o${index}`, employeeId: "e", outcome, ...job,
      })),
    );
    expect(rows.map((row) => row.contribution)).toEqual([1, 0]);
  });

  it("recovery, feedback and training", () => {
    expect(recoveryConversionOpportunities([{ caseId: "c1", employeeId: "e", recovered: true, ...job }])[0]?.contribution).toBe(1);
    expect(feedbackOpportunities([{ feedbackId: "f1", employeeId: "e", rating: 4, ...job }, { feedbackId: "f2", employeeId: "e", rating: 9, ...job }]).map((row) => row.contribution)).toEqual([4]);
    expect(trainingProgressOpportunities([{ assignmentId: "t1", employeeId: "e", completed: false }])).toEqual([{ employeeId: "e", evidenceId: "t1", contribution: 0 }]);
  });
});

describe("aggregateOpportunities", () => {
  it("groups per employee and job type with sample, evidence and the not-enough-data flag", () => {
    const values = aggregateOpportunities(
      [
        { employeeId: "e1", evidenceId: "b", contribution: 1, jobTypeId: "t1", jobCategory: "repair" },
        { employeeId: "e1", evidenceId: "a", contribution: 0, jobTypeId: "t1", jobCategory: "repair" },
        { employeeId: "e1", evidenceId: "c", contribution: 1, jobTypeId: "t2", jobCategory: "repair" },
        { employeeId: "e2", evidenceId: "d", contribution: 1, jobTypeId: "t1", jobCategory: "repair" },
      ],
      "JOB_TYPE",
      2,
    );
    expect(values).toEqual([
      { employeeId: "e1", jobTypeId: "t1", jobCategory: null, numerator: 1, denominator: 2, sampleSize: 2, enoughData: true, evidenceIds: ["a", "b"] },
      { employeeId: "e1", jobTypeId: "t2", jobCategory: null, numerator: 1, denominator: 1, sampleSize: 1, enoughData: false, evidenceIds: ["c"] },
      { employeeId: "e2", jobTypeId: "t1", jobCategory: null, numerator: 1, denominator: 1, sampleSize: 1, enoughData: false, evidenceIds: ["d"] },
    ]);
  });

  it("groups by category when asked, and reports sample 0 for training without assignments", () => {
    const byCategory = aggregateOpportunities(
      [
        { employeeId: "e1", evidenceId: "a", contribution: 5, jobTypeId: "t1", jobCategory: "repair" },
        { employeeId: "e1", evidenceId: "b", contribution: 3, jobTypeId: "t2", jobCategory: "repair" },
      ],
      "JOB_CATEGORY",
      1,
    );
    expect(byCategory).toHaveLength(1);
    expect(byCategory[0]).toMatchObject({ jobCategory: "repair", jobTypeId: null, numerator: 8, denominator: 2 });

    const training = aggregateOpportunities([{ employeeId: "e1", evidenceId: "t", contribution: 1 }], null, 3, ["e1", "e2"]);
    expect(training.map((value) => [value.employeeId, value.numerator, value.sampleSize, value.enoughData])).toEqual([["e1", 1, 1, false], ["e2", 0, 0, false]]);
  });

  it("never produces a value across dimensions or a combined score", () => {
    const [value] = aggregateOpportunities([{ employeeId: "e1", evidenceId: "a", contribution: 1, jobTypeId: "t1", jobCategory: "x" }], "JOB_TYPE", 1);
    expect(Object.keys(value ?? {}).sort()).toEqual(["denominator", "employeeId", "enoughData", "evidenceIds", "jobCategory", "jobTypeId", "numerator", "sampleSize"]);
  });
});

describe("periodLengthDays", () => {
  it("counts days with the end exclusive", () => {
    expect(periodLengthDays("2026-01-01", "2026-02-01")).toBe(31);
  });
});
