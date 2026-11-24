import { describe, expect, it } from "vitest";
import { canTransitionRecovery, isClosedRecoveryStatus, nextRecoveryStatuses } from "@/lib/recovery-lifecycle";
import { classifyPresence, higherPriority, isHighImpact, isInCooldown, matchConditions, validateRuleDefinition, type RecoveryFacts } from "@/lib/recovery-rules";

const facts: RecoveryFacts = {
  outcome: "NOT_SOLD",
  lostReasonId: "r1",
  lostReasonRecoverable: true,
  jobTypeId: "t1",
  valueMinor: 150_000,
  presence: "AT_LOCATION",
  customerRequestedFollowUp: false,
};

describe("validateRuleDefinition", () => {
  const base = { trigger: "job.not_converted", conditions: { outcomes: ["NOT_SOLD"] }, actions: [{ type: "create_case" }, { type: "recommend", code: "call_customer" }] };

  it("accepts a well-formed rule", () => {
    expect(validateRuleDefinition(base)).toMatchObject({ ok: true });
  });

  it("refuses discounts anywhere: action types, keys and values", () => {
    for (const actions of [
      [{ type: "apply_discount", percent: 10 }],
      [{ type: "create_case" }, { type: "recommend", code: "call_customer", discountPercent: 10 }],
      [{ type: "recommend", code: "offer_discount" }],
    ]) {
      const result = validateRuleDefinition({ ...base, actions });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.some((problem) => problem.message.includes("discount"))).toBe(true);
    }
  });

  it("refuses unknown triggers, unknown condition keys, empty actions and bad ranges", () => {
    expect(validateRuleDefinition({ ...base, trigger: "lead.created" }).ok).toBe(false);
    expect(validateRuleDefinition({ ...base, conditions: { color: "red" } }).ok).toBe(false);
    expect(validateRuleDefinition({ ...base, actions: [] }).ok).toBe(false);
    expect(validateRuleDefinition({ ...base, conditions: { minValueMinor: 10, maxValueMinor: 5 } }).ok).toBe(false);
  });
});

describe("isHighImpact", () => {
  it("is true for notifications, tasks and high-priority cases only", () => {
    expect(isHighImpact([{ type: "create_case" }, { type: "recommend", code: "call_customer" }])).toBe(false);
    expect(isHighImpact([{ type: "create_case", priority: "NORMAL" }, { type: "set_priority", priority: "HIGH" }])).toBe(false);
    expect(isHighImpact([{ type: "create_case", priority: "URGENT" }])).toBe(true);
    expect(isHighImpact([{ type: "create_case" }, { type: "notify", audience: "lead_operations" }])).toBe(true);
    expect(isHighImpact([{ type: "create_follow_up", dueInMinutes: 60 }])).toBe(true);
  });
});

describe("matchConditions", () => {
  it("matches an empty condition set and explains every check", () => {
    expect(matchConditions({}, facts)).toEqual({ matched: true, checks: [] });
    const result = matchConditions({ outcomes: ["WORK_NOT_POSSIBLE"], minValueMinor: 100_000, presence: ["AT_LOCATION"] }, facts);
    expect(result.matched).toBe(false);
    expect(result.checks.map((entry) => [entry.condition, entry.passed])).toEqual([
      ["outcomes", false],
      ["presence", true],
      ["minValueMinor", true],
    ]);
  });

  it("never matches a value condition when the value is unknown, nor a reason condition without a reason", () => {
    expect(matchConditions({ minValueMinor: 0 }, { ...facts, valueMinor: null }).matched).toBe(false);
    expect(matchConditions({ lostReasonIds: ["r1"] }, { ...facts, lostReasonId: null }).matched).toBe(false);
    expect(matchConditions({ recoverableReason: true }, { ...facts, lostReasonRecoverable: null }).matched).toBe(false);
  });

  it("checks job types, recoverability and customer requests", () => {
    expect(matchConditions({ jobTypeIds: ["t2"] }, facts).matched).toBe(false);
    expect(matchConditions({ recoverableReason: false }, facts).matched).toBe(false);
    expect(matchConditions({ customerRequestedFollowUp: true }, { ...facts, customerRequestedFollowUp: true }).matched).toBe(true);
  });
});

describe("isInCooldown", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("blocks inside the window only", () => {
    expect(isInCooldown(60, new Date("2026-01-01T11:30:00Z"), now)).toBe(true);
    expect(isInCooldown(60, new Date("2026-01-01T11:00:00Z"), now)).toBe(false);
    expect(isInCooldown(0, new Date("2026-01-01T11:59:00Z"), now)).toBe(false);
    expect(isInCooldown(60, null, now)).toBe(false);
  });
});

describe("classifyPresence (§26.5)", () => {
  const valid = { hasValidLocation: true, radiusM: 150, accuracyM: 20 };
  it("says AT_LOCATION inside the radius and LEFT_LOCATION outside", () => {
    expect(classifyPresence({ ...valid, distanceM: 100 })).toEqual({ status: "AT_LOCATION", reason: null });
    expect(classifyPresence({ ...valid, distanceM: 151 })).toEqual({ status: "LEFT_LOCATION", reason: null });
  });
  it("is UNKNOWN without valid data or without site coordinates, with a reason", () => {
    expect(classifyPresence({ ...valid, hasValidLocation: false, distanceM: null, accuracyM: null })).toEqual({ status: "UNKNOWN", reason: "no_location" });
    expect(classifyPresence({ ...valid, hasValidLocation: false, invalidReason: "stale_location", distanceM: null, accuracyM: null })).toEqual({ status: "UNKNOWN", reason: "stale_location" });
    expect(classifyPresence({ ...valid, distanceM: null })).toEqual({ status: "UNKNOWN", reason: "no_coordinates" });
  });
});

describe("recovery lifecycle (§9.5)", () => {
  it("allows the working path and refuses shortcuts", () => {
    expect(canTransitionRecovery("NEW", "ASSIGNED")).toBe(true);
    expect(canTransitionRecovery("NEW", "RECOVERED")).toBe(false);
    expect(canTransitionRecovery("CLOSED", "NEW")).toBe(false);
    expect(nextRecoveryStatuses("RECOVERED")).toEqual(["CLOSED"]);
    expect(isClosedRecoveryStatus("NOT_RECOVERED")).toBe(true);
    expect(isClosedRecoveryStatus("RECOVERED")).toBe(false);
  });
  it("ranks priorities", () => {
    expect(higherPriority("HIGH", "LOW")).toBe("HIGH");
    expect(higherPriority("NORMAL", "URGENT")).toBe("URGENT");
  });
});
