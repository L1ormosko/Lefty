import { describe, expect, it } from "vitest";
import { MIN_PEERS_FOR_POSITION, assessmentOf, compareRates, positionAmong, type ComparableValue } from "@/lib/metric-position";

const v = (employeeId: string, numerator: number, denominator: number, enoughData = true): ComparableValue => ({ employeeId, numerator, denominator, enoughData });

describe("compareRates", () => {
  it("compares exactly, without floats", () => {
    expect(compareRates({ numerator: 1, denominator: 3 }, { numerator: 2, denominator: 6 })).toBe(0);
    expect(compareRates({ numerator: 2, denominator: 3 }, { numerator: 3, denominator: 5 })).toBe(1);
    expect(compareRates({ numerator: 1, denominator: 10 }, { numerator: 1, denominator: 9 })).toBe(-1);
  });
});

describe("positionAmong", () => {
  const peers = [v("a", 9, 10), v("b", 7, 10), v("c", 5, 10), v("d", 3, 10)];

  it("puts the best in quartile 1 and the lowest in quartile 4, with counts and the team sample size", () => {
    expect(positionAmong(peers[0], peers, "ON_TIME_ARRIVAL")).toEqual({
      status: "POSITIONED",
      peerCount: 4,
      betterCount: 0,
      sameCount: 0,
      worseCount: 3,
      quartile: 1,
      lowerIsBetter: false,
    });
    expect(positionAmong(peers[1], peers, "ON_TIME_ARRIVAL").quartile).toBe(2);
    expect(positionAmong(peers[2], peers, "ON_TIME_ARRIVAL").quartile).toBe(3);
    expect(positionAmong(peers[3], peers, "ON_TIME_ARRIVAL").quartile).toBe(4);
  });

  it("inverts the direction where lower is better (repeat visits)", () => {
    expect(positionAmong(peers[3], peers, "REPEAT_VISIT_RATE")).toMatchObject({ quartile: 1, lowerIsBetter: true, betterCount: 0 });
    expect(positionAmong(peers[0], peers, "REPEAT_VISIT_RATE").quartile).toBe(4);
  });

  it("counts ties half: when everybody is equal, nobody is a strength or an opportunity", () => {
    const equal = [v("a", 1, 2), v("b", 2, 4), v("c", 3, 6), v("d", 5, 10)];
    const position = positionAmong(equal[0], equal, "OUTCOME_CONVERSION");
    expect(position).toMatchObject({ quartile: 2, sameCount: 3, betterCount: 0, worseCount: 0 });
    expect(assessmentOf(position)).toBe("TYPICAL");
  });

  it("gives no position without enough data, or with fewer comparable colleagues than the minimum", () => {
    expect(positionAmong(v("a", 1, 1, false), peers, "ON_TIME_ARRIVAL")).toMatchObject({ status: "NOT_ENOUGH_DATA", quartile: null });
    const few = [peers[0], peers[1], v("x", 0, 0), v("y", 4, 10, false)];
    expect(MIN_PEERS_FOR_POSITION).toBe(4);
    expect(positionAmong(peers[0], few, "ON_TIME_ARRIVAL")).toMatchObject({ status: "NOT_ENOUGH_PEERS", peerCount: 2, betterCount: null });
  });

  it("uses the subject passed in, not a stale copy in the peer list", () => {
    expect(positionAmong(v("d", 10, 10), peers, "ON_TIME_ARRIVAL").quartile).toBe(1);
  });
});

describe("assessmentOf", () => {
  it("maps quartiles to strengths and development opportunities", () => {
    const base = { status: "POSITIONED" as const, peerCount: 4, betterCount: 0, sameCount: 0, worseCount: 0, lowerIsBetter: false };
    expect(assessmentOf({ ...base, quartile: 1 })).toBe("STRENGTH");
    expect(assessmentOf({ ...base, quartile: 3 })).toBe("TYPICAL");
    expect(assessmentOf({ ...base, quartile: 4 })).toBe("DEVELOPMENT_OPPORTUNITY");
    expect(assessmentOf({ ...base, status: "NOT_ENOUGH_PEERS", quartile: null })).toBeNull();
  });
});
