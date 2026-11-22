import { describe, expect, it } from "vitest";
import {
  ACTION_ONLY_STATUSES,
  LEAD_STATUSES,
  LEAD_TRANSITIONS,
  OPTIONAL_LEAD_TRANSITIONS,
  OWNED_STATUSES,
  allowedLeadTransitions,
  canTransitionLead,
  requestableLeadStatuses,
  transitionKey,
} from "@/lib/lead-lifecycle";

describe("lead lifecycle machine (§6.3)", () => {
  it("covers every status of the spec, each with a transition list", () => {
    expect([...LEAD_STATUSES].sort()).toEqual(Object.keys(LEAD_TRANSITIONS).sort());
    expect(LEAD_STATUSES).toHaveLength(12);
  });

  it("walks the default path NEW to DISPATCHED to CONVERTED", () => {
    const path = ["NEW", "ASSIGNED", "CONTACT_ATTEMPTED", "CONTACTED", "QUALIFIED", "SCHEDULED", "DISPATCHED", "CONVERTED"] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionLead(path[index], path[index + 1])).toBe(true);
    }
  });

  it("rejects moves the machine does not contain", () => {
    expect(canTransitionLead("NEW", "CONTACTED")).toBe(false);
    expect(canTransitionLead("CONVERTED", "ASSIGNED")).toBe(false);
    expect(canTransitionLead("CANCELLED", "UNASSIGNED")).toBe(false);
    expect(canTransitionLead("QUALIFIED", "QUALIFIED")).toBe(false);
    expect(canTransitionLead("LOST", "QUALIFIED")).toBe(false);
  });

  it("makes CONVERTED and CANCELLED final, and lets LOST and DUPLICATE be reopened", () => {
    expect(allowedLeadTransitions("CONVERTED")).toEqual([]);
    expect(allowedLeadTransitions("CANCELLED")).toEqual([]);
    expect(allowedLeadTransitions("LOST")).toEqual(["UNASSIGNED"]);
    expect(allowedLeadTransitions("DUPLICATE")).toEqual(["UNASSIGNED"]);
  });

  it("lets a tenant switch off an optional transition", () => {
    const disabled = [transitionKey("ASSIGNED", "CONTACTED")];
    expect(canTransitionLead("ASSIGNED", "CONTACTED")).toBe(true);
    expect(canTransitionLead("ASSIGNED", "CONTACTED", disabled)).toBe(false);
  });

  it("never lets a tenant block the default path or add a transition", () => {
    expect(canTransitionLead("ASSIGNED", "CONTACT_ATTEMPTED", [transitionKey("ASSIGNED", "CONTACT_ATTEMPTED")])).toBe(true);
    expect(canTransitionLead("NEW", "CONTACTED", ["NEW>CONTACTED"])).toBe(false);
    expect(allowedLeadTransitions("NEW", ["bogus", "NEW>", ">NEW", "FOO>BAR"])).toEqual(allowedLeadTransitions("NEW"));
  });

  it("lists every optional transition a tenant may disable, none of them on the default path", () => {
    expect(OPTIONAL_LEAD_TRANSITIONS).toContain("QUALIFIED>LOST");
    expect(OPTIONAL_LEAD_TRANSITIONS).not.toContain("QUALIFIED>SCHEDULED");
    expect(OPTIONAL_LEAD_TRANSITIONS).not.toContain("DISPATCHED>CONVERTED");
  });

  it("reaches CONVERTED only from the stages after qualification", () => {
    const sources = LEAD_STATUSES.filter((status) => canTransitionLead(status, "CONVERTED"));
    expect(sources).toEqual(["QUALIFIED", "SCHEDULED", "DISPATCHED"]);
  });

  it("offers the status endpoint neither ASSIGNED nor CONVERTED, nor UNASSIGNED while somebody owns the lead", () => {
    expect(ACTION_ONLY_STATUSES).toEqual(["ASSIGNED", "CONVERTED"]);
    expect(requestableLeadStatuses("QUALIFIED")).not.toContain("CONVERTED");
    expect(requestableLeadStatuses("NEW")).not.toContain("ASSIGNED");
    for (const owned of OWNED_STATUSES) expect(requestableLeadStatuses(owned)).not.toContain("UNASSIGNED");
    expect(requestableLeadStatuses("NEW")).toContain("UNASSIGNED");
    expect(requestableLeadStatuses("LOST")).toEqual(["UNASSIGNED"]);
  });
});
