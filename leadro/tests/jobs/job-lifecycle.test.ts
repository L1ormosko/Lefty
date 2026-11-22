import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  OPTIONAL_TRANSITION_KEYS,
  TERMINAL_JOB_STATUSES,
  allowedNextStatuses,
  appointmentWarnings,
  canTransitionJob,
  effectiveDisabledTransitions,
  invalidDisabledTransitions,
  transitionGuardProblem,
  transitionKey,
  transitionProblem,
  type JobStatusValue,
} from "@/lib/job-lifecycle";

const facts = { requiresReview: false, hasActiveAssignment: true, hasScheduledSlot: true };

describe("job lifecycle machine (§7.2)", () => {
  it("walks the default path, one core edge at a time", () => {
    const path: JobStatusValue[] = ["CREATED", "PENDING_ASSIGNMENT", "ASSIGNED", "SCHEDULED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "CLOSED"];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionJob(path[index], path[index + 1]), `${path[index]} > ${path[index + 1]}`).toBe(true);
    }
  });

  it("blocks edges that skip the path or go backwards", () => {
    expect(canTransitionJob("CREATED", "COMPLETED")).toBe(false);
    expect(canTransitionJob("PENDING_ASSIGNMENT", "IN_PROGRESS")).toBe(false);
    expect(canTransitionJob("ASSIGNED", "EN_ROUTE")).toBe(false); // must be scheduled first
    expect(canTransitionJob("IN_PROGRESS", "ASSIGNED")).toBe(false);
    expect(canTransitionJob("CLOSED", "IN_PROGRESS")).toBe(false);
    expect(canTransitionJob("SCHEDULED", "SCHEDULED")).toBe(false);
  });

  it("has no way out of CLOSED or CANCELLED", () => {
    for (const status of TERMINAL_JOB_STATUSES) expect(allowedNextStatuses(status)).toEqual([]);
  });

  it("lists every edge once and only between known statuses", () => {
    const keys = JOB_TRANSITIONS.map((rule) => transitionKey(rule.from, rule.to));
    expect(new Set(keys).size).toBe(keys.length);
    for (const rule of JOB_TRANSITIONS) {
      expect(JOB_STATUSES).toContain(rule.from);
      expect(JOB_STATUSES).toContain(rule.to);
    }
  });

  it("lets every open job reach CLOSED through core edges alone, whatever a tenant switches off", () => {
    const everythingOff = effectiveDisabledTransitions(OPTIONAL_TRANSITION_KEYS);
    for (const start of JOB_STATUSES.filter((status) => !TERMINAL_JOB_STATUSES.includes(status))) {
      const seen = new Set<JobStatusValue>([start]);
      const queue: JobStatusValue[] = [start];
      while (queue.length > 0) {
        for (const next of allowedNextStatuses(queue.shift() as JobStatusValue, everythingOff)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.has("CLOSED"), `${start} can still reach CLOSED`).toBe(true);
    }
  });
});

describe("tenant narrowing", () => {
  it("lets a tenant switch an optional edge off", () => {
    const disabled = effectiveDisabledTransitions(["CREATED>CANCELLED"]);
    expect(canTransitionJob("CREATED", "CANCELLED", disabled)).toBe(false);
    expect(canTransitionJob("PENDING_ASSIGNMENT", "CANCELLED", disabled)).toBe(true);
  });

  it("ignores core edges, unknown edges and edges that never existed: a tenant can never add or remove default-path transitions", () => {
    const disabled = effectiveDisabledTransitions(["SCHEDULED>EN_ROUTE", "CREATED>CLOSED", "nonsense", "CLOSED>CREATED"]);
    expect(disabled.size).toBe(0);
    expect(canTransitionJob("SCHEDULED", "EN_ROUTE", disabled)).toBe(true);
    expect(canTransitionJob("CREATED", "CLOSED", disabled)).toBe(false); // still not invented
    expect(canTransitionJob("CLOSED", "CREATED", disabled)).toBe(false);
  });

  it("reports what a tenant asked to switch off that it may not", () => {
    expect(invalidDisabledTransitions(["CREATED>CANCELLED", "SCHEDULED>EN_ROUTE", "x"])).toEqual(["SCHEDULED>EN_ROUTE", "x"]);
  });

  it("explains a refusal as not allowed, switched off, or a guard", () => {
    const disabled = effectiveDisabledTransitions(["CREATED>CANCELLED"]);
    expect(transitionProblem("CREATED", "CLOSED", disabled, facts)?.code).toBe("NOT_ALLOWED");
    expect(transitionProblem("CREATED", "CANCELLED", disabled, facts)?.code).toBe("DISABLED");
    expect(transitionProblem("ASSIGNED", "SCHEDULED", disabled, { ...facts, hasScheduledSlot: false })?.code).toBe("GUARD");
    expect(transitionProblem("ASSIGNED", "SCHEDULED", disabled, facts)).toBeNull();
  });
});

describe("transition guards", () => {
  it("routes COMPLETED to review or close depending on the job type", () => {
    expect(transitionGuardProblem("COMPLETED", "CLOSED", { ...facts, requiresReview: true })).toMatch(/review/);
    expect(transitionGuardProblem("COMPLETED", "AWAITING_REVIEW", facts)).toMatch(/does not require review/);
    expect(transitionGuardProblem("COMPLETED", "AWAITING_REVIEW", { ...facts, requiresReview: true })).toBeNull();
    expect(transitionGuardProblem("COMPLETED", "CLOSED", facts)).toBeNull();
  });

  it("needs an assignee for assigned-and-later statuses and a slot for SCHEDULED", () => {
    expect(transitionGuardProblem("PENDING_ASSIGNMENT", "ASSIGNED", { ...facts, hasActiveAssignment: false })).toMatch(/Assign/);
    expect(transitionGuardProblem("ASSIGNED", "SCHEDULED", { ...facts, hasScheduledSlot: false })).toMatch(/scheduled time/);
    expect(transitionGuardProblem("ON_HOLD", "PENDING_ASSIGNMENT", { ...facts, hasActiveAssignment: false })).toBeNull();
  });

  it("asks for review permissions only on review decisions", () => {
    expect(JOB_TRANSITIONS.find((rule) => rule.from === "AWAITING_REVIEW" && rule.to === "CLOSED")?.permission).toBe("jobs.approve");
    expect(JOB_TRANSITIONS.find((rule) => rule.from === "AWAITING_REVIEW" && rule.to === "IN_PROGRESS")?.permission).toBe("jobs.reject");
  });
});

describe("appointment warnings (§25.2)", () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 10, 30, hour));
  it("warns when the estimated duration is longer than the arrival window", () => {
    expect(appointmentWarnings({ estimatedDurationMinutes: 180, window: { start: at(8), end: at(10) } })).toEqual([
      { code: "DURATION_EXCEEDS_WINDOW", params: { estimatedDurationMinutes: 180, windowMinutes: 120 } },
    ]);
  });
  it("warns when the scheduled slot is shorter than the duration, and stays silent when it fits", () => {
    expect(appointmentWarnings({ estimatedDurationMinutes: 90, slot: { start: at(8), end: at(9) } })[0].code).toBe("SLOT_SHORTER_THAN_DURATION");
    expect(appointmentWarnings({ estimatedDurationMinutes: 60, window: { start: at(8), end: at(10) }, slot: { start: at(8), end: at(9) } })).toEqual([]);
  });
});
