import { describe, expect, it } from "vitest";
import { findParamsProblem, isChannelOptedOut, retryDelayMs, MAX_DELIVERY_ATTEMPTS } from "@/lib/notification-rules";

describe("findParamsProblem (ids only, no PII)", () => {
  it("accepts ids, numbers, codes and booleans", () => {
    expect(findParamsProblem({ leadId: "clx9a1b2c3", leadNumber: 1042, status: "NEW", urgent: true, ref: "a.b:c-d_e" })).toBeNull();
  });

  it.each([
    ["a name", { customerName: "Jane Doe" }],
    ["an email", { email: "jane@example.com" }],
    ["a phone number", { phone: "+15551234567" }],
    ["an empty string", { id: "" }],
    ["a very long string", { id: "x".repeat(65) }],
    ["a nested object", { id: { a: 1 } }],
    ["null", { id: null }],
    ["NaN", { count: Number.NaN }],
    ["a snake_case name", { lead_id: "abc" }],
  ])("rejects %s", (_label, params) => {
    expect(findParamsProblem(params)).not.toBeNull();
  });

  it("rejects more than ten params", () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`p${index}`, index]));
    expect(findParamsProblem(many)).toMatch(/at most/);
  });
});

describe("isChannelOptedOut", () => {
  const rows = [
    { eventType: "*", channel: "EMAIL", enabled: false },
    { eventType: "job.assigned", channel: "EMAIL", enabled: true },
    { eventType: "lead.assigned", channel: "SMS", enabled: false },
  ];

  it("treats a missing row as enabled", () => {
    expect(isChannelOptedOut([], "job.assigned", "EMAIL")).toBe(false);
    expect(isChannelOptedOut(rows, "job.assigned", "PUSH")).toBe(false);
  });

  it("applies the * row to every event of that channel only", () => {
    expect(isChannelOptedOut(rows, "lead.assigned", "EMAIL")).toBe(true);
    expect(isChannelOptedOut(rows, "lead.assigned", "SMS")).toBe(true);
    expect(isChannelOptedOut(rows, "job.rescheduled", "SMS")).toBe(false);
  });

  it("lets an event-specific row override the * row", () => {
    expect(isChannelOptedOut(rows, "job.assigned", "EMAIL")).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("backs off, then gives up after the last attempt", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(MAX_DELIVERY_ATTEMPTS)).toBeNull();
  });
});
