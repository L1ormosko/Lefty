/**
 * Pure aggregation behind the KPI engine (spec 13.2, 13.4): bucketing facts by period in the tenant time zone, rolling org units
 * up to a level of the org tree, attributing employees to the assignment effective at the event time (spec 3), and reducing a
 * group of facts to one value per the KPI's unit. No Prisma, no Next: the analytics module loads the facts and calls these.
 */
import type { KpiOrgLevel, KpiUnit } from "./kpi-catalog";
import { addDays, endOfLocalDay, isoDayOfWeek, localIsoDate, startOfLocalDay } from "./zoned-time";

export const KPI_GRANULARITIES = ["DAY", "WEEK", "MONTH", "TOTAL"] as const;
export type KpiGranularity = (typeof KPI_GRANULARITIES)[number];

/** Longest date range one request may cover (a year, leap day included). */
export const MAX_KPI_RANGE_DAYS = 366;
/** At most this many source record ids are listed per value row; the query descriptor finds the rest. */
export const MAX_DRILL_DOWN_IDS = 50;

/** One source record as a KPI sees it. Which optional fields are set depends on the KPI's unit. */
export interface KpiFact {
  recordId: string;
  /** The anchor instant (decides the period bucket). */
  at: Date;
  /** The org unit the record is attributed to (record snapshot, or the employee's historical assignment). */
  orgUnitId: string | null;
  /** Value of the KPI's fixed breakdown (e.g. the lead source id; null = none). */
  breakdownId?: string | null;
  /** MONEY: the record's currency. */
  currency?: string;
  /** RATE: whether the record is in the numerator. */
  hit?: boolean;
  /** DURATION: elapsed milliseconds. */
  durationMs?: number;
  /** MONEY: amount in minor units. */
  amountMinor?: bigint;
  /** RATIO: who contributed the record (the denominator counts distinct contributors). */
  contributorId?: string;
}

export interface KpiValueRow {
  /** Local date (YYYY-MM-DD) the bucket starts on; null for a SNAPSHOT KPI. */
  periodStart: string | null;
  /** The group's org unit at the requested level; null at TENANT level (the whole scope) or when no ancestor has that level. */
  orgUnitId: string | null;
  breakdownId?: string | null;
  currency?: string;
  /** COUNT: count; RATE / RATIO: numerator / denominator; DURATION: median seconds; MONEY: sum in minor units. */
  value: number | bigint | null;
  numerator?: number;
  denominator?: number;
  /** Records behind the value (for DURATION: records with a measured duration). */
  sampleCount: number;
  /** Up to `MAX_DRILL_DOWN_IDS` source record ids, in a stable order. */
  recordIds: string[];
  recordIdsTruncated: boolean;
}

/** The instants a local date range covers: [start of `from`, start of the day after `to`) in `zone`. */
export function localDateRange(from: string, to: string, zone: string): { start: Date; end: Date } {
  return { start: new Date(startOfLocalDay(from, zone)), end: new Date(endOfLocalDay(to, zone)) };
}

/** Number of calendar days from `from` to `to`, both included. */
export function rangeLengthDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Local date the bucket containing `at` starts on. Weeks start on Monday (ISO 8601); TOTAL is one bucket starting at `rangeFrom`. */
export function periodStartOf(at: Date, granularity: KpiGranularity, zone: string, rangeFrom: string): string {
  if (granularity === "TOTAL") return rangeFrom;
  const localDate = localIsoDate(at.getTime(), zone);
  if (granularity === "DAY") return localDate;
  if (granularity === "WEEK") return addDays(localDate, 1 - isoDayOfWeek(localDate));
  return `${localDate.slice(0, 7)}-01`;
}

export interface OrgTreeNode {
  parentId: string | null;
  type: string;
}

/**
 * The unit (itself or its nearest ancestor) of type `level`, walking the CURRENT org tree. TENANT groups everything together
 * (null). Null as well when no unit on the path has that level (e.g. a branch attached directly to a state, grouped by city).
 */
export function rollUpToLevel(orgUnitId: string | null, level: KpiOrgLevel, tree: ReadonlyMap<string, OrgTreeNode>): string | null {
  if (level === "TENANT" || orgUnitId === null) return null;
  const seen = new Set<string>();
  let current: string | null = orgUnitId;
  while (current !== null && !seen.has(current)) {
    seen.add(current); // a guard only: the database forbids cycles
    const node = tree.get(current);
    if (!node) return null;
    if (node.type === level) return current;
    current = node.parentId;
  }
  return null;
}

export interface PlacementWindow {
  orgUnitId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Spec 3: historical figures use the organizational assignment effective AT THE EVENT, never today's. The placement covering
 * `at` (effectiveFrom <= at < effectiveTo); when two overlap (a transfer recorded late), the one that started last wins.
 */
export function placementAt(placements: readonly PlacementWindow[], at: Date): string | null {
  const time = at.getTime();
  let best: PlacementWindow | null = null;
  for (const placement of placements) {
    const covers = placement.effectiveFrom.getTime() <= time && (placement.effectiveTo === null || time < placement.effectiveTo.getTime());
    if (covers && (best === null || placement.effectiveFrom.getTime() > best.effectiveFrom.getTime())) best = placement;
  }
  return best?.orgUnitId ?? null;
}

/** Median of the values (mean of the two middle ones for an even count); null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Reduces the facts of ONE group to its value. */
function reduceGroup(unit: KpiUnit, facts: readonly KpiFact[]): Pick<KpiValueRow, "value" | "numerator" | "denominator" | "sampleCount"> {
  switch (unit) {
    case "COUNT":
      return { value: facts.length, sampleCount: facts.length };
    case "RATE": {
      const numerator = facts.filter((fact) => fact.hit === true).length;
      return { value: facts.length === 0 ? null : numerator / facts.length, numerator, denominator: facts.length, sampleCount: facts.length };
    }
    case "RATIO": {
      const contributors = new Set(facts.map((fact) => fact.contributorId).filter((id): id is string => id !== undefined));
      return {
        value: contributors.size === 0 ? null : facts.length / contributors.size,
        numerator: facts.length,
        denominator: contributors.size,
        sampleCount: facts.length,
      };
    }
    case "DURATION": {
      const durations = facts.map((fact) => fact.durationMs).filter((ms): ms is number => ms !== undefined && ms >= 0);
      const middle = median(durations);
      return { value: middle === null ? null : Math.round(middle / 1000), sampleCount: durations.length };
    }
    case "MONEY": {
      let total = 0n;
      for (const fact of facts) total += fact.amountMinor ?? 0n;
      return { value: total, sampleCount: facts.length };
    }
  }
}

export interface AggregateOptions {
  /** Bucket start of a fact, or null for a SNAPSHOT KPI. */
  periodOf: (fact: KpiFact) => string | null;
  /** The group org unit of a fact at the requested level. */
  groupOf: (fact: KpiFact) => string | null;
  /** Whether rows carry the fact's breakdown id. */
  withBreakdown: boolean;
}

/**
 * Groups facts by period, org group, breakdown and (for MONEY) currency, and reduces each group per `unit`. Money is never summed
 * across currencies: the currency is part of the group key. Rows are sorted by period, then org unit, breakdown and currency.
 */
export function aggregateFacts(facts: readonly KpiFact[], unit: KpiUnit, options: AggregateOptions): KpiValueRow[] {
  const groups = new Map<string, { row: Omit<KpiValueRow, "value" | "sampleCount" | "recordIds" | "recordIdsTruncated">; facts: KpiFact[] }>();
  for (const fact of facts) {
    const periodStart = options.periodOf(fact);
    const orgUnitId = options.groupOf(fact);
    const breakdownId = options.withBreakdown ? (fact.breakdownId ?? null) : undefined;
    const currency = unit === "MONEY" ? (fact.currency ?? "") : undefined;
    const key = JSON.stringify([periodStart, orgUnitId, breakdownId ?? null, currency ?? null]);
    let group = groups.get(key);
    if (!group) {
      group = {
        row: {
          periodStart,
          orgUnitId,
          ...(options.withBreakdown ? { breakdownId: breakdownId ?? null } : {}),
          ...(currency !== undefined ? { currency } : {}),
        },
        facts: [],
      };
      groups.set(key, group);
    }
    group.facts.push(fact);
  }

  const rows = [...groups.values()].map(({ row, facts: groupFacts }) => {
    const ids = groupFacts.map((fact) => fact.recordId).sort();
    return {
      ...row,
      ...reduceGroup(unit, groupFacts),
      recordIds: ids.slice(0, MAX_DRILL_DOWN_IDS),
      recordIdsTruncated: ids.length > MAX_DRILL_DOWN_IDS,
    };
  });
  const sortKey = (row: KpiValueRow) => [row.periodStart ?? "", row.orgUnitId ?? "", row.breakdownId ?? "", row.currency ?? ""].join("\u0000");
  return rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}
