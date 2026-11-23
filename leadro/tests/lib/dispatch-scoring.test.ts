import { describe, expect, it } from "vitest";
import { haversineKm, rankCandidates, scoreCandidate, type CandidateFacts } from "@/lib/dispatch-scoring";

const facts = (overrides: Partial<CandidateFacts> & { employeeId: string }): CandidateFacts => ({
  distanceKm: 10,
  openJobCount: 0,
  completedOfTypeCount: 0,
  customerPreference: null,
  ...overrides,
});

const newYork = { latitude: 40.7128, longitude: -74.006 };
const losAngeles = { latitude: 34.0522, longitude: -118.2437 };

describe("haversineKm", () => {
  it("is zero for the same point and symmetric", () => {
    expect(haversineKm(newYork, newYork)).toBe(0);
    expect(haversineKm(newYork, losAngeles)).toBeCloseTo(haversineKm(losAngeles, newYork), 9);
  });
  it("matches a known distance (New York to Los Angeles is about 3936 km)", () => {
    const km = haversineKm(newYork, losAngeles);
    expect(km).toBeGreaterThan(3930);
    expect(km).toBeLessThan(3945);
  });
});

describe("scoreCandidate", () => {
  it("gives the best possible employee 100 points with four explained factors", () => {
    const scored = scoreCandidate(facts({ employeeId: "e", distanceKm: 0, completedOfTypeCount: 10, customerPreference: "PREFERRED" }));
    expect(scored.score).toBe(100);
    expect(scored.factors.map((factor) => factor.key)).toEqual(["DISTANCE", "WORKLOAD", "EXPERIENCE", "PREFERENCE"]);
    expect(scored.factors.every((factor) => factor.explanationKey.startsWith("DISPATCH.FACTOR."))).toBe(true);
    expect(scored.conflicts).toEqual([]);
  });
  it("sums to the factor contributions", () => {
    const scored = scoreCandidate(facts({ employeeId: "e", distanceKm: 25, openJobCount: 2, completedOfTypeCount: 3 }));
    expect(scored.factors.map((factor) => factor.contribution)).toEqual([20, 18, 6, 0]);
    expect(scored.score).toBe(44);
  });
  it("scores unknown distance as the neutral half and flags it instead of punishing", () => {
    const scored = scoreCandidate(facts({ employeeId: "e", distanceKm: null }));
    expect(scored.factors[0]).toMatchObject({ value: null, contribution: 20, explanationKey: "DISPATCH.FACTOR.DISTANCE_UNKNOWN" });
    expect(scored.conflicts.map((conflict) => conflict.code)).toEqual(["DISTANCE_UNKNOWN"]);
  });
  it("penalises an avoided employee and reports the conflict; heavy workload and far jobs are flagged", () => {
    const scored = scoreCandidate(facts({ employeeId: "e", distanceKm: 80, openJobCount: 6, customerPreference: "AVOID" }));
    expect(scored.factors[0].contribution).toBe(0);
    expect(scored.factors[1].contribution).toBe(0);
    expect(scored.factors[3].contribution).toBe(-30);
    expect(scored.conflicts.map((conflict) => conflict.code)).toEqual(["CUSTOMER_AVOIDS_EMPLOYEE", "HEAVY_WORKLOAD", "FAR_FROM_JOB"]);
    expect(scored.conflicts[0].messageKey).toBe("DISPATCH.CONFLICT.CUSTOMER_AVOIDS_EMPLOYEE");
  });
  it("caps experience", () => {
    expect(scoreCandidate(facts({ employeeId: "e", completedOfTypeCount: 500 })).factors[2].contribution).toBe(20);
  });
});

describe("rankCandidates", () => {
  it("orders by score, assigns ranks from 1 and is independent of input order", () => {
    const input = [facts({ employeeId: "far", distanceKm: 45 }), facts({ employeeId: "near", distanceKm: 2 }), facts({ employeeId: "busy", distanceKm: 2, openJobCount: 4 })];
    const ranked = rankCandidates(input);
    expect(ranked.map((candidate) => [candidate.employeeId, candidate.rank])).toEqual([
      ["near", 1],
      ["busy", 2],
      ["far", 3],
    ]);
    expect(rankCandidates([...input].reverse())).toEqual(ranked);
  });
  it("breaks ties by employee id, and by nearer distance with unknown distance last", () => {
    const sameScore = rankCandidates([facts({ employeeId: "b", distanceKm: null }), facts({ employeeId: "a", distanceKm: null })]);
    expect(sameScore.map((candidate) => candidate.employeeId)).toEqual(["a", "b"]);
    // Both score 20 + 30 = 50: 25 km gives 20 points, unknown gives the neutral 20.
    const byDistance = rankCandidates([facts({ employeeId: "a", distanceKm: null }), facts({ employeeId: "z", distanceKm: 25 })]);
    expect(byDistance.map((candidate) => candidate.employeeId)).toEqual(["z", "a"]);
  });
  it("returns an empty ranking for no candidates", () => {
    expect(rankCandidates([])).toEqual([]);
  });
  it("lets a nearer employee beat a preferred one 30 km away: preference adds at most 10 points", () => {
    const ranked = rankCandidates([facts({ employeeId: "pref", distanceKm: 30, customerPreference: "PREFERRED" }), facts({ employeeId: "near", distanceKm: 0 })]);
    expect(ranked[0].employeeId).toBe("near");
  });
});
