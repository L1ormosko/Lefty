import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_STATUSES,
  canTransitionFollowUp,
  isFollowUpDueSoon,
  isFollowUpOverdue,
  nextFollowUpStatuses,
} from "@/lib/follow-up-lifecycle";

const now = new Date("2026-11-23T12:00:00Z");
const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe("follow-up status machine", () => {
  it("lets an open task start, finish or be cancelled, and a closed one only be reopened", () => {
    expect(nextFollowUpStatuses("OPEN")).toEqual(["IN_PROGRESS", "DONE", "CANCELLED"]);
    expect(nextFollowUpStatuses("DONE")).toEqual(["OPEN"]);
    expect(nextFollowUpStatuses("CANCELLED")).toEqual(["OPEN"]);
  });

  it("never allows a no-op or DONE <-> CANCELLED", () => {
    for (const status of FOLLOW_UP_STATUSES) expect(canTransitionFollowUp(status, status)).toBe(false);
    expect(canTransitionFollowUp("DONE", "CANCELLED")).toBe(false);
    expect(canTransitionFollowUp("CANCELLED", "DONE")).toBe(false);
  });
});

describe("overdue and due-soon", () => {
  it("is overdue only for an open task strictly past due", () => {
    expect(isFollowUpOverdue("OPEN", minutesFromNow(-1), now)).toBe(true);
    expect(isFollowUpOverdue("IN_PROGRESS", minutesFromNow(-1), now)).toBe(true);
    expect(isFollowUpOverdue("OPEN", now, now)).toBe(false);
    expect(isFollowUpOverdue("DONE", minutesFromNow(-60), now)).toBe(false);
    expect(isFollowUpOverdue("CANCELLED", minutesFromNow(-60), now)).toBe(false);
  });

  it("is due soon inside the window, inclusive at both ends, and never once overdue", () => {
    expect(isFollowUpDueSoon("OPEN", now, now, 60)).toBe(true);
    expect(isFollowUpDueSoon("OPEN", minutesFromNow(60), now, 60)).toBe(true);
    expect(isFollowUpDueSoon("OPEN", minutesFromNow(61), now, 60)).toBe(false);
    expect(isFollowUpDueSoon("OPEN", minutesFromNow(-1), now, 60)).toBe(false);
    expect(isFollowUpDueSoon("DONE", minutesFromNow(10), now, 60)).toBe(false);
  });
});
