import { describe, expect, it } from "vitest";
import {
  addDays,
  endOfLocalDay,
  firstInstantAtOrAfterWall,
  isoDayOfWeek,
  localIsoDate,
  startOfLocalDay,
  wallMsOf,
} from "@/lib/zoned-time";

const NY = "America/New_York";
const iso = (ms: number) => new Date(ms).toISOString();

describe("zoned time helpers", () => {
  it("reads a local calendar date and ISO weekday", () => {
    // 03:30 UTC on Tue 2026-11-24 is still Monday evening in New York.
    const instant = Date.parse("2026-11-24T03:30:00Z");
    expect(localIsoDate(instant, NY)).toBe("2026-11-23");
    expect(isoDayOfWeek("2026-11-23")).toBe(1);
    expect(isoDayOfWeek("2026-11-22")).toBe(7);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("maps an ordinary wall time to its instant in winter and in summer", () => {
    expect(iso(firstInstantAtOrAfterWall(wallMsOf("2026-01-15", 9 * 60), NY))).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(firstInstantAtOrAfterWall(wallMsOf("2026-07-15", 9 * 60), NY))).toBe("2026-07-15T13:00:00.000Z");
  });

  it("maps a skipped wall time (02:30 on the spring-forward day) to the moment the clocks jump", () => {
    // 2026-03-08: 02:00 EST -> 03:00 EDT, i.e. 07:00 UTC. 02:30 does not exist.
    expect(iso(firstInstantAtOrAfterWall(wallMsOf("2026-03-08", 2 * 60 + 30), NY))).toBe("2026-03-08T07:00:00.000Z");
  });

  it("maps a repeated wall time (01:30 on the fall-back day) to its first occurrence", () => {
    // 2026-11-01: 02:00 EDT -> 01:00 EST. 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
    expect(iso(firstInstantAtOrAfterWall(wallMsOf("2026-11-01", 60 + 30), NY))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("local days are 23 and 25 hours long on the DST days", () => {
    expect((endOfLocalDay("2026-03-08", NY) - startOfLocalDay("2026-03-08", NY)) / 3_600_000).toBe(23);
    expect((endOfLocalDay("2026-11-01", NY) - startOfLocalDay("2026-11-01", NY)) / 3_600_000).toBe(25);
    expect((endOfLocalDay("2026-06-01", NY) - startOfLocalDay("2026-06-01", NY)) / 3_600_000).toBe(24);
  });

  it("works for a zone east of UTC with a half-hour offset", () => {
    expect(iso(firstInstantAtOrAfterWall(wallMsOf("2026-05-01", 8 * 60), "Asia/Kolkata"))).toBe("2026-05-01T02:30:00.000Z");
  });
});
